import { describe, expect, it, vi } from "vitest";
import { ComposioWebhookPayloadError } from "@composio/core";

process.env.COMPOSIO_API_KEY = "test";
process.env.SIGNUP_WEBHOOK_SECRET = "s3cret";
process.env.ADMIN_TOKEN = "admin";
process.env.DEDUPE_WINDOW_MINUTES = "60";

const killSwitch = vi.hoisted(() => ({ setInstantEnabled: vi.fn(async (_s: unknown, enabled: boolean) => ({ enabled, sessionsUpdated: [], errors: [] })) }));
vi.mock("../src/killSwitch.js", async (orig) => ({ ...(await orig<typeof import("../src/killSwitch.js")>()), setInstantEnabled: killSwitch.setInstantEnabled }));

const { createApp, createQueue } = await import("../src/server.js");
const { Store } = await import("../src/store.js");

function app(verifyTrigger?: Parameters<typeof createApp>[0]["verifyTrigger"]) {
  const store = new Store(":memory:");
  const enqueue = vi.fn();
  return { store, enqueue, app: createApp({ store, enqueue, ...(verifyTrigger ? { verifyTrigger } : {}) }) };
}

const signup = (body: unknown, secret = "s3cret") =>
  new Request("http://x/webhooks/signup", { method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": secret }, body: JSON.stringify(body) });

describe("POST /webhooks/signup", () => {
  it("accepts a new lead once; a redelivery of the same event_id does no work", async () => {
    const { app: a, enqueue } = app();
    const first = await a.request(signup({ event_id: "evt_1", email: "jane@acme.io", source: "demo_booking" }));
    const again = await a.request(signup({ event_id: "evt_1", email: "jane@acme.io", source: "demo_booking" }));
    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    const [b1, b2] = [(await first.json()) as { leadId: string }, await again.json()];
    expect(b2).toMatchObject({ status: "duplicate", reason: "event_id", leadId: b1.leadId });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("dedupes the same email under a new event_id within the window", async () => {
    const { app: a, enqueue } = app();
    await a.request(signup({ event_id: "evt_1", email: "jane@acme.io" }));
    const res = await a.request(signup({ event_id: "evt_2", email: "JANE@acme.io" }));
    expect(await res.json()).toMatchObject({ status: "duplicate", reason: "email_window" });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("rejects a bad secret and invalid payloads without claiming the event", async () => {
    const { app: a, enqueue, store } = app();
    expect((await a.request(signup({ event_id: "e", email: "jane@acme.io" }, "wrong"))).status).toBe(401);
    expect((await a.request(signup({ event_id: "e", email: "not-an-email" }))).status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.db.prepare("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 0 });
  });
});

describe("POST /webhooks/composio (Calendly trigger)", () => {
  const delivery = (id = "msg_1") =>
    new Request("http://x/webhooks/composio", {
      method: "POST",
      headers: { "webhook-id": id, "webhook-signature": "v1,sig", "webhook-timestamp": "1" },
      body: "{}",
    });

  it("maps a verified booking to a lead and dedupes redeliveries by invitee URI", async () => {
    const verify = vi.fn(async () => ({ triggerSlug: "CALENDLY_MEETING_SCHEDULED", payload: { email: "sam@beta.dev", name: "Sam", uri: "https://api.calendly.com/inv/1" } }));
    const { app: a, enqueue } = app(verify);
    expect((await a.request(delivery("msg_1"))).status).toBe(202);
    expect((await a.request(delivery("msg_2"))).status).toBe(200); // new delivery id, same booking
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]![0].lead).toMatchObject({ email: "sam@beta.dev", source: "calendly", event_id: "calendly:https://api.calendly.com/inv/1" });
    expect(verify).toHaveBeenCalledWith({ id: "msg_1", payload: "{}", signature: "v1,sig", timestamp: "1" });
  });

  it("rejects bad signatures and ignores other triggers", async () => {
    const { app: bad } = app(async () => Promise.reject(new Error("sig")));
    expect((await bad.request(delivery())).status).toBe(401);
    const { app: unparseable } = app(async () => Promise.reject(new ComposioWebhookPayloadError("bad shape")));
    expect(await (await unparseable.request(delivery())).json()).toMatchObject({ status: "ignored" });
    const { app: other, enqueue } = app(async () => ({ triggerSlug: "SLACK_RECEIVE_MESSAGE", payload: {} }));
    expect(await (await other.request(delivery())).json()).toMatchObject({ status: "ignored" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("admin", () => {
  const auth = { authorization: "Bearer admin" };

  it("requires the admin token (lead data is personal)", async () => {
    const { app: a } = app();
    expect((await a.request("/admin/instant")).status).toBe(401);
    expect((await a.request("/admin/leads/x", { headers: auth })).status).toBe(404);
  });

  it("kill switch endpoint flips Instant off", async () => {
    const { app: a } = app();
    const res = await a.request("/admin/instant", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    expect(await res.json()).toMatchObject({ enabled: false });
    expect(killSwitch.setInstantEnabled).toHaveBeenCalledWith(expect.anything(), false);
    expect((await a.request("/admin/instant", { method: "POST", headers: auth, body: "{}" })).status).toBe(400);
  });

  it("cost summary splits tiers and lists unresolved reservations", async () => {
    const { app: a, store } = app();
    const r1 = store.reserve({ leadId: "l", runKey: "l:tier1", sessionId: null, toolSlug: "A", amount: 10n ** 10n, runBudget: 10n ** 12n, globalCap: 10n ** 12n });
    if (r1.ok) store.resolveReservation(r1.id, { status: "settled", actual: 5_980_000_000n });
    const r2 = store.reserve({ leadId: "l", runKey: "l:tier2", sessionId: null, toolSlug: "B", amount: 10n ** 10n, runBudget: 10n ** 12n, globalCap: 10n ** 12n });
    if (r2.ok) store.resolveReservation(r2.id, { status: "unresolved" });
    const body = (await (await a.request("/admin/costs", { headers: auth })).json()) as { unresolved: unknown[] };
    expect(body).toMatchObject({ settledUsd: "0.00598", tier1Usd: "0.00598", tier2Usd: "0.00" });
    expect(body.unresolved).toHaveLength(1);
  });
});

describe("createQueue", () => {
  it("runs at most N jobs at once and keeps going after a failure", async () => {
    let running = 0, peak = 0, done = 0;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const enqueue = createQueue(2, async (job) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--; done++;
      if (job.leadId === "bad") throw new Error("boom");
    });
    const lead = { event_id: "e", email: "a@b.co", source: "signup" as const };
    for (const id of ["a", "bad", "c", "d"]) enqueue({ lead, leadId: id });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(4);
    expect(peak).toBe(2);
    errSpy.mockRestore();
  });
});
