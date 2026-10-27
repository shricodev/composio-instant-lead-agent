import { getComposio } from "./composio.js";
import { picoToUsd, usdToPico } from "./money.js";
import type { Reservation, Store } from "./store.js";

// Reconcile "unresolved" reservations (timeouts, network errors, completed calls
// whose charge wasn't visible) against Composio's execution logs. Run this
// BEFORE retrying any lead: the provider may already have done billable work.

export type LogEntry = { id: string; timestamp: string; status: string; metadata: Record<string, unknown> };

export type LogSource = {
  get(logId: string): Promise<LogEntry>;
  search(params: { sessionId: string; toolSlug: string; from: number; to: number }): Promise<LogEntry[]>;
};

export const composioLogs: LogSource = {
  async get(logId) {
    return (await getComposio().logs.get(logId)) as unknown as LogEntry;
  },
  async search({ sessionId, toolSlug, from, to }) {
    const res = await getComposio().logs.search({
      filters: [
        { field: "session_id", operator: "==", value: sessionId },
        { field: "tool_slug", operator: "==", value: toolSlug },
      ],
      timeRange: { from, to },
      limit: 20,
    });
    return res.logs as unknown as LogEntry[];
  },
};

export type ReconcileOutcome = { id: number; toolSlug: string; outcome: "settled" | "released" | "still_unresolved"; chargeUsd?: string; detail: string };

/** Logs can lag; give a call this long before treating "no log" as "never ran". */
const LOG_GRACE_MS = 10 * 60_000;

export async function reconcileUnresolved(store: Store, logs: LogSource = composioLogs, now = Date.now()): Promise<ReconcileOutcome[]> {
  const out: ReconcileOutcome[] = [];
  for (const r of store.reservations({ status: "unresolved" })) {
    try {
      out.push(await reconcileOne(store, logs, r, now));
    } catch (err) {
      out.push({ id: r.id, toolSlug: r.toolSlug, outcome: "still_unresolved", detail: `log lookup failed: ${String(err).slice(0, 160)}` });
    }
  }
  return out;
}

async function reconcileOne(store: Store, logs: LogSource, r: Reservation, now: number): Promise<ReconcileOutcome> {
  const createdAt = (store.db.prepare("SELECT created_at FROM reservations WHERE id = ?").get(r.id) as { created_at: number }).created_at;

  let entry: LogEntry | undefined;
  if (r.logId) entry = await logs.get(r.logId);
  else if (r.sessionId) {
    // The call threw before we got a log id: find it by session + tool + time.
    const found = await logs.search({ sessionId: r.sessionId, toolSlug: r.toolSlug, from: createdAt - 60_000, to: createdAt + LOG_GRACE_MS });
    const claimed = new Set(store.reservations({ runKey: r.runKey }).map((x) => x.logId).filter(Boolean));
    entry = found.find((l) => !claimed.has(l.id));
  }

  if (!entry) {
    if (now - createdAt < LOG_GRACE_MS)
      return { id: r.id, toolSlug: r.toolSlug, outcome: "still_unresolved", detail: "no execution log yet; retry reconcile later" };
    store.resolveReservation(r.id, { status: "released", actual: 0n, note: "no execution log found after grace period" });
    return { id: r.id, toolSlug: r.toolSlug, outcome: "released", detail: "no execution log: call never reached the provider" };
  }

  const charge = typeof entry.metadata.instant_charge === "string" ? usdToPico(entry.metadata.instant_charge) : undefined;
  const source = typeof entry.metadata.credential_source === "string" ? entry.metadata.credential_source : null;
  if (charge !== undefined) {
    store.resolveReservation(r.id, { status: "settled", actual: charge, logId: entry.id, credentialSource: source, note: "reconciled from execution log" });
    return { id: r.id, toolSlug: r.toolSlug, outcome: "settled", chargeUsd: picoToUsd(charge), detail: `log ${entry.id} (${entry.status})` };
  }
  if (entry.status === "failed" || (source !== null && source !== "instant_account")) {
    store.resolveReservation(r.id, { status: "released", actual: 0n, logId: entry.id, credentialSource: source, note: `log ${entry.status}, source ${source}` });
    return { id: r.id, toolSlug: r.toolSlug, outcome: "released", detail: `log ${entry.id}: ${entry.status}, no charge` };
  }
  if (now - createdAt < LOG_GRACE_MS)
    return { id: r.id, toolSlug: r.toolSlug, outcome: "still_unresolved", detail: `log ${entry.id} has no charge yet` };
  // Successful Instant call whose log never recorded a charge: record $0 but say so.
  store.resolveReservation(r.id, { status: "settled", actual: 0n, logId: entry.id, credentialSource: source, note: "log shows success with no instant_charge" });
  return { id: r.id, toolSlug: r.toolSlug, outcome: "settled", chargeUsd: "0.00", detail: `log ${entry.id}: success, no charge recorded` };
}
