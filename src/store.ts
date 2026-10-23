import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Pico } from "./money.js";

// SQLite holds three things: webhook idempotency, the lead records, and the
// Instant cost ledger (one row per reservation). Amounts are stored as TEXT
// because SQLite integers are 64-bit and pico-USD is a bigint in our code.

export type ReservationStatus =
  | "reserved" // in flight; counts against the budget at its reserved amount
  | "settled" // actual charge known
  | "released" // no charge (failed call, own-account call, wallet refused)
  | "unresolved"; // outcome unknown (timeout/network); counts at reserved amount until reconciled

export type Reservation = {
  id: number;
  leadId: string;
  runKey: string;
  sessionId: string | null;
  toolSlug: string;
  reservedPico: Pico;
  actualPico: Pico | null;
  status: ReservationStatus;
  logId: string | null;
  credentialSource: string | null;
  note: string | null;
};

export type LeadRecord = {
  leadId: string;
  eventId: string;
  email: string;
  status: string;
  tier1SessionId: string | null;
  tier2SessionId: string | null;
  result: unknown;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  email_norm TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_email ON events(email_norm, received_at);

CREATE TABLE IF NOT EXISTS leads (
  lead_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  tier1_session_id TEXT,
  tier2_session_id TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL,
  run_key TEXT NOT NULL,
  session_id TEXT,
  tool_slug TEXT NOT NULL,
  reserved_pico TEXT NOT NULL,
  actual_pico TEXT,
  status TEXT NOT NULL,
  log_id TEXT,
  credential_source TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_run ON reservations(run_key);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type ReservationRow = {
  id: number;
  lead_id: string;
  run_key: string;
  session_id: string | null;
  tool_slug: string;
  reserved_pico: string;
  actual_pico: string | null;
  status: ReservationStatus;
  log_id: string | null;
  credential_source: string | null;
  note: string | null;
};

function toReservation(r: ReservationRow): Reservation {
  return {
    id: r.id,
    leadId: r.lead_id,
    runKey: r.run_key,
    sessionId: r.session_id,
    toolSlug: r.tool_slug,
    reservedPico: BigInt(r.reserved_pico),
    actualPico: r.actual_pico === null ? null : BigInt(r.actual_pico),
    status: r.status,
    logId: r.log_id,
    credentialSource: r.credential_source,
    note: r.note,
  };
}

/** What a reservation counts against a budget: actual if known, else the reserved bound. */
function committed(r: Reservation): Pico {
  switch (r.status) {
    case "settled":
      return r.actualPico ?? 0n;
    case "released":
      return 0n;
    case "reserved":
    case "unresolved":
      return r.reservedPico;
  }
}

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  // ---------- idempotency ----------

  /**
   * Claim an inbound event. Returns the existing lead id for a duplicate event_id,
   * or for the same email seen within `dedupeWindowMs`; otherwise records the event.
   */
  claimEvent(input: { eventId: string; email: string; leadId: string; dedupeWindowMs: number; now?: number }):
    | { duplicate: false; leadId: string }
    | { duplicate: true; leadId: string; reason: "event_id" | "email_window" } {
    const now = input.now ?? Date.now();
    const emailNorm = input.email.trim().toLowerCase();
    // BEGIN IMMEDIATE: take the write lock up front so two deliveries can't both claim.
    return this.db.transaction(() => {
      const byId = this.db.prepare("SELECT lead_id FROM events WHERE event_id = ?").get(input.eventId) as
        | { lead_id: string }
        | undefined;
      if (byId) return { duplicate: true as const, leadId: byId.lead_id, reason: "event_id" as const };

      const byEmail = this.db
        .prepare("SELECT lead_id FROM events WHERE email_norm = ? AND received_at >= ? ORDER BY received_at DESC LIMIT 1")
        .get(emailNorm, now - input.dedupeWindowMs) as { lead_id: string } | undefined;
      // Still record this event_id so a redelivery of it short-circuits on the first check.
      this.db
        .prepare("INSERT INTO events (event_id, email_norm, lead_id, received_at) VALUES (?, ?, ?, ?)")
        .run(input.eventId, emailNorm, byEmail?.lead_id ?? input.leadId, now);
      if (byEmail) return { duplicate: true as const, leadId: byEmail.lead_id, reason: "email_window" as const };
      return { duplicate: false as const, leadId: input.leadId };
    }).immediate();
  }

  // ---------- leads ----------

  upsertLead(lead: Partial<LeadRecord> & { leadId: string; eventId: string; email: string; status: string }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO leads (lead_id, event_id, email, status, tier1_session_id, tier2_session_id, result_json, created_at, updated_at)
         VALUES (@leadId, @eventId, @email, @status, @tier1SessionId, @tier2SessionId, @resultJson, @now, @now)
         ON CONFLICT(lead_id) DO UPDATE SET
           status = excluded.status,
           tier1_session_id = COALESCE(excluded.tier1_session_id, leads.tier1_session_id),
           tier2_session_id = COALESCE(excluded.tier2_session_id, leads.tier2_session_id),
           result_json = COALESCE(excluded.result_json, leads.result_json),
           updated_at = excluded.updated_at`,
      )
      .run({
        leadId: lead.leadId,
        eventId: lead.eventId,
        email: lead.email,
        status: lead.status,
        tier1SessionId: lead.tier1SessionId ?? null,
        tier2SessionId: lead.tier2SessionId ?? null,
        // Ledger amounts are bigint pico-USD; persist them as decimal strings.
        resultJson: lead.result === undefined ? null : JSON.stringify(lead.result, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
        now,
      });
  }

  getLead(leadId: string): LeadRecord | undefined {
    const r = this.db.prepare("SELECT * FROM leads WHERE lead_id = ?").get(leadId) as
      | { lead_id: string; event_id: string; email: string; status: string; tier1_session_id: string | null; tier2_session_id: string | null; result_json: string | null }
      | undefined;
    if (!r) return undefined;
    return {
      leadId: r.lead_id,
      eventId: r.event_id,
      email: r.email,
      status: r.status,
      tier1SessionId: r.tier1_session_id,
      tier2SessionId: r.tier2_session_id,
      result: r.result_json ? (JSON.parse(r.result_json) as unknown) : null,
    };
  }

  listLeads(): LeadRecord[] {
    const ids = this.db.prepare("SELECT lead_id FROM leads ORDER BY created_at").all() as { lead_id: string }[];
    return ids.map((r) => this.getLead(r.lead_id)!);
  }

  // ---------- cost ledger ----------

  /**
   * Atomically reserve `amount` for one tool call if it fits both the run budget
   * and the global cap. Returns the reservation id, or the reason it was refused.
   */
  reserve(input: {
    leadId: string;
    runKey: string;
    sessionId: string | null;
    toolSlug: string;
    amount: Pico;
    runBudget: Pico;
    globalCap: Pico;
  }): { ok: true; id: number } | { ok: false; reason: "run_budget" | "global_cap"; committedRun: Pico; committedGlobal: Pico } {
    return this.db.transaction(() => {
      const committedRun = this.committedFor("run_key = ?", input.runKey);
      const committedGlobal = this.committedFor("1 = 1");
      if (committedRun + input.amount > input.runBudget)
        return { ok: false as const, reason: "run_budget" as const, committedRun, committedGlobal };
      if (committedGlobal + input.amount > input.globalCap)
        return { ok: false as const, reason: "global_cap" as const, committedRun, committedGlobal };
      const now = Date.now();
      const info = this.db
        .prepare(
          `INSERT INTO reservations (lead_id, run_key, session_id, tool_slug, reserved_pico, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(input.leadId, input.runKey, input.sessionId, input.toolSlug, input.amount.toString(), now, now);
      return { ok: true as const, id: Number(info.lastInsertRowid) };
    }).immediate();
  }

  resolveReservation(
    id: number,
    update: { status: Exclude<ReservationStatus, "reserved">; actual?: Pico | null; logId?: string | null; credentialSource?: string | null; note?: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE reservations SET status = ?, actual_pico = ?, log_id = COALESCE(?, log_id),
           credential_source = COALESCE(?, credential_source), note = COALESCE(?, note), updated_at = ?
         WHERE id = ?`,
      )
      .run(
        update.status,
        update.actual === undefined || update.actual === null ? null : update.actual.toString(),
        update.logId ?? null,
        update.credentialSource ?? null,
        update.note ?? null,
        Date.now(),
        id,
      );
  }

  reservations(where: { runKey?: string; leadId?: string; status?: ReservationStatus } = {}): Reservation[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (where.runKey) (clauses.push("run_key = ?"), params.push(where.runKey));
    if (where.leadId) (clauses.push("lead_id = ?"), params.push(where.leadId));
    if (where.status) (clauses.push("status = ?"), params.push(where.status));
    const sql = `SELECT * FROM reservations ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY id`;
    return (this.db.prepare(sql).all(...params) as ReservationRow[]).map(toReservation);
  }

  /** Sum of settled charges for a run (what we actually spent, as far as we know). */
  spentFor(runKey: string): Pico {
    return this.reservations({ runKey })
      .filter((r) => r.status === "settled")
      .reduce((sum, r) => sum + (r.actualPico ?? 0n), 0n);
  }

  private committedFor(where: string, ...params: unknown[]): Pico {
    const rows = this.db.prepare(`SELECT * FROM reservations WHERE ${where}`).all(...params) as ReservationRow[];
    return rows.map(toReservation).reduce((sum, r) => sum + committed(r), 0n);
  }

  // ---------- settings (kill switch) ----------

  getSetting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
