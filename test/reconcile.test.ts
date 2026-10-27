import { describe, expect, it, vi } from "vitest";

process.env.COMPOSIO_API_KEY = "test";

const restore = vi.hoisted(() => ({ update: vi.fn(async (_c: unknown) => ({})) }));
vi.mock("../src/composio.js", async (orig) => ({
  ...(await orig<typeof import("../src/composio.js")>()),
  restoreSession: vi.fn(async () => ({ update: restore.update })),
}));

const { reconcileUnresolved } = await import("../src/reconcile.js");
const { isInstantEnabled, setInstantEnabled, trackSession } = await import("../src/killSwitch.js");
const { columnLetter, rowNumber } = await import("../src/outputs/crm.js");
const { shouldRunTier2 } = await import("../src/pipeline/processLead.js");
const { Store } = await import("../src/store.js");

const BIG = 10n ** 12n;
function unresolved(store: InstanceType<typeof Store>, opts: { logId?: string; sessionId?: string } = {}) {
  const r = store.reserve({ leadId: "l", runKey: "l:tier1", sessionId: opts.sessionId ?? "trs_1", toolSlug: "FIRECRAWL_SCRAPE", amount: 3_000_000_000n, runBudget: BIG, globalCap: BIG });
  if (!r.ok) throw new Error("reserve failed");
  store.resolveReservation(r.id, { status: "unresolved", logId: opts.logId ?? null });
  return r.id;
}

describe("reconcileUnresolved", () => {
  it("settles from the log's instant_charge", async () => {
    const store = new Store(":memory:");
    unresolved(store, { logId: "log_1" });
    const logs = { get: vi.fn(async () => ({ id: "log_1", timestamp: "", status: "success", metadata: { instant_charge: "0.000798", credential_source: "instant_account" } })), search: vi.fn() };
    const [out] = await reconcileUnresolved(store, logs);
    expect(out).toMatchObject({ outcome: "settled", chargeUsd: "0.000798" });
    expect(store.reservations()[0]).toMatchObject({ status: "settled", actualPico: 798_000_000n });
  });

  it("a timeout with no log id is found by session + tool + time", async () => {
    const store = new Store(":memory:");
    unresolved(store);
    const search = vi.fn(async () => [{ id: "log_9", timestamp: "", status: "success", metadata: { instant_charge: "0.003" } }]);
    const [out] = await reconcileUnresolved(store, { get: vi.fn(), search });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "trs_1", toolSlug: "FIRECRAWL_SCRAPE" }));
    expect(out!.outcome).toBe("settled");
  });

  it("no log: stays unresolved during the grace period, released after it", async () => {
    const store = new Store(":memory:");
    unresolved(store);
    const logs = { get: vi.fn(), search: vi.fn(async () => []) };
    expect((await reconcileUnresolved(store, logs))[0]!.outcome).toBe("still_unresolved");
    expect((await reconcileUnresolved(store, logs, Date.now() + 11 * 60_000))[0]!.outcome).toBe("released");
  });

  it("failed or own-account calls are released at $0", async () => {
    const store = new Store(":memory:");
    unresolved(store, { logId: "log_1" });
    const logs = { get: vi.fn(async () => ({ id: "log_1", timestamp: "", status: "failed", metadata: { credential_source: "instant_account" } })), search: vi.fn() };
    expect((await reconcileUnresolved(store, logs))[0]!.outcome).toBe("released");
  });
});

describe("kill switch", () => {
  it("persists the flag and updates in-flight sessions; re-enable resends the full policy", async () => {
    const store = new Store(":memory:");
    expect(isInstantEnabled(store)).toBe(true);
    const untrack = trackSession("trs_live", "tier1");

    await setInstantEnabled(store, false);
    expect(isInstantEnabled(store)).toBe(false);
    expect(restore.update).toHaveBeenLastCalledWith({ instant: false });

    await setInstantEnabled(store, true);
    const policy = (restore.update.mock.calls.at(-1)![0] as { instant: { toolkits: unknown; tools: Record<string, unknown> } }).instant;
    // Not a partial object: the per-tool allowlist must come back with it.
    expect(policy.toolkits).toEqual({ enable: ["hunter", "apollo", "firecrawl", "serper"] });
    expect(Object.keys(policy.tools)).toContain("apollo");
    untrack();
  });
});

describe("helpers", () => {
  it("CRM row/column addressing", () => {
    expect(rowNumber("Leads!A5:U5")).toBe(5);
    expect(rowNumber("'My Leads'!A12:U12")).toBe(12);
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(19)).toBe("T");
    expect(columnLetter(26)).toBe("AA");
  });

  it("tier 2 only for scored, enriched leads at or above the threshold", () => {
    const t1 = (status: string, score?: number) => ({ status, score: score === undefined ? null : { score } }) as Parameters<typeof shouldRunTier2>[0];
    expect(shouldRunTier2(t1("enriched", 75), 75)).toBe(true);
    expect(shouldRunTier2(t1("partial", 90), 75)).toBe(true);
    expect(shouldRunTier2(t1("enriched", 74), 75)).toBe(false);
    expect(shouldRunTier2(t1("unenriched", 99), 75)).toBe(false);
    expect(shouldRunTier2(t1("rejected_email"), 75)).toBe(false);
  });
});
