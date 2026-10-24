import { loadConfig } from "../config.js";
import type { LeadSession } from "../composio.js";

// CRM = a Google Sheet, written through the workspace's OWN Google connection
// (not Instant). Column order is documented in data/crm_schema.md.

export const CRM_COLUMNS = [
  "received_at",
  "lead_id",
  "source",
  "email",
  "name",
  "company",
  "domain",
  "title",
  "seniority",
  "company_size",
  "industry",
  "score",
  "tier",
  "summary",
  "fit_reasons",
  "risks",
  "enrichment_status",
  "enrichment_provider",
  "instant_cost_usd",
  "tier2_cost_usd",
  "research_brief",
] as const;

export type CrmRow = Partial<Record<(typeof CRM_COLUMNS)[number], string | number | null>>;

export type CrmWriteResult = { ok: true; updatedRange?: string; url: string } | { ok: false; error: string };

export async function appendCrmRow(session: LeadSession, row: CrmRow): Promise<CrmWriteResult> {
  return append(session, [CRM_COLUMNS.map((c) => row[c] ?? null)]);
}

export async function appendCrmHeader(session: LeadSession): Promise<CrmWriteResult> {
  return append(session, [[...CRM_COLUMNS]]);
}

async function append(session: LeadSession, values: (string | number | null)[][]): Promise<CrmWriteResult> {
  const cfg = loadConfig();
  if (!cfg.GOOGLE_SHEET_ID) return { ok: false, error: "GOOGLE_SHEET_ID not set" };
  // No `account` option: this runs on the workspace's own connected account.
  const res = await session.execute("GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", {
    spreadsheetId: cfg.GOOGLE_SHEET_ID,
    range: `${cfg.GOOGLE_SHEET_TAB}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    majorDimension: "ROWS",
    values,
  });
  if (res.error) return { ok: false, error: res.error };
  const updates = (res.data.updates ?? (res.data as { data?: { updates?: unknown } }).data?.updates) as
    | { updatedRange?: string }
    | undefined;
  const url = `https://docs.google.com/spreadsheets/d/${cfg.GOOGLE_SHEET_ID}/edit`;
  return { ok: true, url, ...(updates?.updatedRange ? { updatedRange: updates.updatedRange } : {}) };
}

/** "Leads!A5:U5" -> 5 */
export function rowNumber(updatedRange: string): number | undefined {
  const m = /![A-Z]+(\d+)/.exec(updatedRange);
  return m ? Number(m[1]) : undefined;
}

export function columnLetter(index: number): string {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Write tier-2 results into the lead's existing row (tier2_cost_usd + research_brief). */
export async function updateResearch(session: LeadSession, updatedRange: string, tier2CostUsd: string, brief: string): Promise<CrmWriteResult> {
  const cfg = loadConfig();
  const row = rowNumber(updatedRange);
  if (!cfg.GOOGLE_SHEET_ID || row === undefined) return { ok: false, error: `cannot locate CRM row from "${updatedRange}"` };
  const from = columnLetter(CRM_COLUMNS.indexOf("tier2_cost_usd"));
  const to = columnLetter(CRM_COLUMNS.indexOf("research_brief"));
  const res = await session.execute("GOOGLESHEETS_UPDATE_VALUES_BATCH", {
    spreadsheet_id: cfg.GOOGLE_SHEET_ID,
    valueInputOption: "RAW",
    data: [{ range: `${cfg.GOOGLE_SHEET_TAB}!${from}${row}:${to}${row}`, majorDimension: "ROWS", values: [[tier2CostUsd, brief]] }],
  });
  if (res.error) return { ok: false, error: res.error };
  return { ok: true, url: `https://docs.google.com/spreadsheets/d/${cfg.GOOGLE_SHEET_ID}/edit`, updatedRange: `${cfg.GOOGLE_SHEET_TAB}!${from}${row}:${to}${row}` };
}
