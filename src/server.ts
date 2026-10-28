import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getComposio } from "./composio.js";
import { loadConfig } from "./config.js";
import { isInstantEnabled, setInstantEnabled } from "./killSwitch.js";
import { SignupEventSchema, type SignupEvent } from "./lead.js";
import { picoToUsd } from "./money.js";
import { processLead } from "./pipeline/processLead.js";
import { reconcileUnresolved } from "./reconcile.js";
import { Store } from "./store.js";

// HTTP surface:
//   POST /webhooks/signup     any signup/demo form (JSON body, optional x-webhook-secret)
//   POST /webhooks/composio   Composio trigger delivery (Calendly "meeting scheduled"), signed
//   GET  /admin/leads/:id     lead status, results and cost ledger (contains personal data)
//   GET|POST /admin/instant   kill switch (Bearer ADMIN_TOKEN)
//   GET  /admin/costs         local cost ledger summary
//   POST /admin/reconcile     settle unresolved reservations from execution logs
//
// Webhooks are acknowledged immediately and processed by a small in-process queue.
// Delivery is at-least-once, so every event is claimed in SQLite first: a duplicate
// (same event_id, or same email inside the dedupe window) returns 200 and does no work.
// For us a duplicate would mean paying twice for the same lead.

export type Enqueue = (job: { lead: SignupEvent; leadId: string }) => void;

export type TriggerVerifier = (input: { id: string; payload: string; signature: string; timestamp: string }) => Promise<{
  triggerSlug: string;
  payload: Record<string, unknown>;
}>;

const CALENDLY_TRIGGER = "CALENDLY_MEETING_SCHEDULED";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(deps: { store: Store; enqueue: Enqueue; verifyTrigger?: TriggerVerifier }) {
  const cfg = loadConfig();
  const { store, enqueue } = deps;
  const app = new Hono();

  const accept = (c: Context, lead: SignupEvent) => {
    const claim = store.claimEvent({
      eventId: lead.event_id,
      email: lead.email,
      leadId: `lead_${randomUUID().slice(0, 8)}`,
      dedupeWindowMs: cfg.DEDUPE_WINDOW_MINUTES * 60_000,
    });
    if (claim.duplicate) return c.json({ status: "duplicate", reason: claim.reason, leadId: claim.leadId }, 200);
    store.upsertLead({ leadId: claim.leadId, eventId: lead.event_id, email: lead.email, status: "queued" });
    enqueue({ lead, leadId: claim.leadId });
    return c.json({ status: "accepted", leadId: claim.leadId }, 202);
  };

  app.get("/health", (c) => c.json({ ok: true, instantEnabled: isInstantEnabled(store) }));

  app.post("/webhooks/signup", async (c) => {
    if (cfg.SIGNUP_WEBHOOK_SECRET && !safeEqual(c.req.header("x-webhook-secret") ?? "", cfg.SIGNUP_WEBHOOK_SECRET))
      return c.json({ error: "invalid secret" }, 401);
    const body = await c.req.json().catch(() => undefined);
    const parsed = SignupEventSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    return accept(c, parsed.data);
  });

  app.post("/webhooks/composio", async (c) => {
    if (!deps.verifyTrigger) return c.json({ error: "COMPOSIO_WEBHOOK_SECRET not configured" }, 503);
    const raw = await c.req.text();
    let event: Awaited<ReturnType<TriggerVerifier>>;
    try {
      event = await deps.verifyTrigger({
        id: c.req.header("webhook-id") ?? "",
        payload: raw,
        signature: c.req.header("webhook-signature") ?? "",
        timestamp: c.req.header("webhook-timestamp") ?? "",
      });
    } catch {
      return c.json({ error: "invalid signature" }, 401);
    }
    // Acknowledge triggers we don't handle so Composio doesn't keep retrying them.
    if (event.triggerSlug !== CALENDLY_TRIGGER) return c.json({ status: "ignored", triggerSlug: event.triggerSlug }, 200);

    const p = event.payload;
    const email = typeof p.email === "string" ? p.email : undefined;
    // The invitee URI identifies the booking itself, so a redelivery under a new
    // webhook id still dedupes. Fall back to the delivery id.
    const eventId = typeof p.uri === "string" ? `calendly:${p.uri}` : `composio:${c.req.header("webhook-id") ?? randomUUID()}`;
    const parsed = SignupEventSchema.safeParse({
      event_id: eventId,
      email,
      name: typeof p.name === "string" ? p.name : undefined,
      source: "calendly",
    });
    if (!parsed.success) return c.json({ status: "ignored", reason: "no usable invitee email" }, 200);
    return accept(c, parsed.data);
  });

  // ---- admin ----
  app.use("/admin/*", async (c, next) => {
    if (!cfg.ADMIN_TOKEN) return c.json({ error: "admin disabled: set ADMIN_TOKEN" }, 403);
    if (!safeEqual(c.req.header("authorization") ?? "", `Bearer ${cfg.ADMIN_TOKEN}`)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/admin/leads/:id", (c) => {
    const lead = store.getLead(c.req.param("id"));
    if (!lead) return c.json({ error: "not found" }, 404);
    const ledger = store.reservations({ leadId: lead.leadId }).map((r) => ({
      tool: r.toolSlug,
      run: r.runKey.split(":")[1],
      status: r.status,
      chargeUsd: r.actualPico === null ? null : picoToUsd(r.actualPico),
      credentialSource: r.credentialSource,
    }));
    return c.json({ ...lead, ledger });
  });

  app.get("/admin/instant", (c) => c.json({ enabled: isInstantEnabled(store) }));

  app.post("/admin/instant", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return c.json({ error: 'body must be {"enabled": true|false}' }, 400);
    return c.json(await setInstantEnabled(store, body.enabled));
  });

  app.get("/admin/costs", (c) => {
    const rows = store.reservations();
    const sum = (f: (r: (typeof rows)[number]) => boolean) =>
      picoToUsd(rows.filter(f).reduce((s, r) => s + (r.status === "settled" ? (r.actualPico ?? 0n) : 0n), 0n));
    const unresolved = rows.filter((r) => r.status === "unresolved" || r.status === "reserved");
    return c.json({
      settledUsd: sum(() => true),
      tier1Usd: sum((r) => r.runKey.endsWith(":tier1")),
      tier2Usd: sum((r) => r.runKey.endsWith(":tier2")),
      unresolved: unresolved.map((r) => ({ id: r.id, leadId: r.leadId, tool: r.toolSlug, reservedUsd: picoToUsd(r.reservedPico) })),
      devCapUsd: cfg.DEV_SPEND_CAP_USD,
    });
  });

  app.post("/admin/reconcile", async (c) => c.json(await reconcileUnresolved(store)));

  return app;
}

/** Minimal in-process queue: N leads at a time, the rest wait their turn. */
export function createQueue(concurrency: number, worker: (job: { lead: SignupEvent; leadId: string }) => Promise<void>): Enqueue {
  const pending: { lead: SignupEvent; leadId: string }[] = [];
  let running = 0;
  const pump = () => {
    while (running < concurrency && pending.length > 0) {
      const job = pending.shift()!;
      running++;
      worker(job)
        .catch((err: unknown) => console.error(`[queue] ${job.leadId} failed:`, err))
        .finally(() => {
          running--;
          pump();
        });
    }
  };
  return (job) => {
    pending.push(job);
    pump();
  };
}

function main() {
  const cfg = loadConfig();
  const store = new Store(cfg.DB_PATH);

  // Leads interrupted by a crash/restart are NOT retried automatically: a paid call
  // may already have run. Reconcile their reservations, then resubmit deliberately.
  const interrupted = store.db
    .prepare("UPDATE leads SET status = 'interrupted' WHERE status IN ('queued', 'processing', 'researching')")
    .run().changes;
  if (interrupted > 0) console.warn(`[startup] marked ${interrupted} unfinished lead(s) as interrupted; run POST /admin/reconcile before resubmitting`);

  const enqueue = createQueue(cfg.CONCURRENCY, async ({ lead, leadId }) => {
    const r = await processLead(store, lead, leadId);
    console.log(
      `[lead] ${leadId} ${lead.email} -> ${r.tier1.status} score=${r.tier1.score?.score ?? "-"} tier1=$${r.tier1.instantCostUsd}` +
        (r.tier2 ? ` tier2=$${r.tier2.costUsd} (${r.tier2.status})` : ""),
    );
  });

  const verifyTrigger: TriggerVerifier | undefined = cfg.COMPOSIO_WEBHOOK_SECRET
    ? async (input) => {
        const res = await getComposio().triggers.verifyWebhook({ ...input, secret: cfg.COMPOSIO_WEBHOOK_SECRET! });
        return { triggerSlug: res.payload.triggerSlug, payload: res.payload.payload ?? {} };
      }
    : undefined;

  const app = createApp({ store, enqueue, ...(verifyTrigger ? { verifyTrigger } : {}) });
  serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
    console.log(`Inbound enrichment agent listening on http://localhost:${info.port}`);
    console.log(`  Instant: ${isInstantEnabled(store) ? "enabled" : "DISABLED (kill switch)"} · tier1 budget $${cfg.TIER1_BUDGET_USD} · tier2 budget $${cfg.TIER2_BUDGET_USD} · cap $${cfg.DEV_SPEND_CAP_USD}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
