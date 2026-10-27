// Real cost per lead, from Composio's own records (free endpoints only):
//   - execution logs filtered by each lead's session_id (tier 1 and tier 2 separately)
//   - the project usage summary (total Instant spend for the window)
// and compared against the local ledger.
//
//   npm run report                 # last 30 days
//   npm run report -- --days 7
//   npm run report -- --reconcile  # settle unresolved reservations first

import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getComposio } from "../composio.js";
import { loadConfig } from "../config.js";
import { picoToUsd, usdToPico, type Pico } from "../money.js";
import { reconcileUnresolved } from "../reconcile.js";
import { Store } from "../store.js";

const { values } = parseArgs({ options: { days: { type: "string", default: "30" }, reconcile: { type: "boolean", default: false } } });

type SessionCost = { instant: Pico; instantCalls: number; ownCalls: number; failed: number; bySlug: Map<string, Pico> };

async function sessionCost(sessionId: string, from: number, to: number): Promise<SessionCost> {
  const out: SessionCost = { instant: 0n, instantCalls: 0, ownCalls: 0, failed: 0, bySlug: new Map() };
  let cursor: string | null | undefined;
  do {
    const page = await getComposio().logs.search({
      filters: [{ field: "session_id", operator: "==", value: sessionId }],
      timeRange: { from, to },
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const log of page.logs) {
      const meta = log.metadata as Record<string, unknown>;
      const slug = String(meta.tool_slug ?? meta.action ?? log.message ?? "?");
      if (log.status === "failed") out.failed++;
      if (meta.credential_source === "instant_account") out.instantCalls++;
      else if (meta.credential_source === "connected_account") out.ownCalls++;
      if (typeof meta.instant_charge === "string") {
        const c = usdToPico(meta.instant_charge);
        out.instant += c;
        out.bySlug.set(slug, (out.bySlug.get(slug) ?? 0n) + c);
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

async function sumSessions(ids: string[], from: number, to: number): Promise<SessionCost> {
  const total: SessionCost = { instant: 0n, instantCalls: 0, ownCalls: 0, failed: 0, bySlug: new Map() };
  for (const id of ids) {
    const c = await sessionCost(id, from, to);
    total.instant += c.instant;
    total.instantCalls += c.instantCalls;
    total.ownCalls += c.ownCalls;
    total.failed += c.failed;
    for (const [k, v] of c.bySlug) total.bySlug.set(k, (total.bySlug.get(k) ?? 0n) + v);
  }
  return total;
}

async function main() {
  const cfg = loadConfig();
  const store = new Store(cfg.DB_PATH);
  const to = Date.now();
  const from = to - Number(values.days) * 24 * 3600_000;

  if (values.reconcile) {
    const rec = await reconcileUnresolved(store);
    console.log(`Reconciled ${rec.length} unresolved reservation(s):`);
    for (const r of rec) console.log(`  #${r.id} ${r.toolSlug}: ${r.outcome}${r.chargeUsd ? ` $${r.chargeUsd}` : ""} (${r.detail})`);
  }

  const rows: string[][] = [];
  let t1Total = 0n, t2Total = 0n, t1Leads = 0, t2Leads = 0, ledgerTotal = 0n;
  for (const lead of store.listLeads()) {
    // A lead can have several sessions per tier (e.g. research re-run), so take
    // every session the ledger saw, plus the ones recorded on the lead.
    const sessions = (tier: "tier1" | "tier2", recorded: string | null) => [
      ...new Set([
        ...store.reservations({ runKey: `${lead.leadId}:${tier}` }).map((r) => r.sessionId),
        recorded,
      ].filter((x): x is string => !!x)),
    ];
    const s1 = sessions("tier1", lead.tier1SessionId);
    const s2 = sessions("tier2", lead.tier2SessionId);
    if (s1.length === 0) continue;
    const t1 = await sumSessions(s1, from, to);
    const t2 = s2.length > 0 ? await sumSessions(s2, from, to) : undefined;
    const ledger = store.reservations({ leadId: lead.leadId }).reduce((s, r) => s + (r.status === "settled" ? (r.actualPico ?? 0n) : 0n), 0n);
    const logs = t1.instant + (t2?.instant ?? 0n);
    // Averages only count runs that actually executed a paid call.
    if (t1.instantCalls > 0) (t1Total += t1.instant), t1Leads++;
    if (t2 && t2.instantCalls > 0) (t2Total += t2.instant), t2Leads++;
    ledgerTotal += ledger;
    rows.push([
      lead.leadId,
      lead.status,
      `$${picoToUsd(t1.instant)}`,
      t2 ? `$${picoToUsd(t2.instant)}` : "-",
      `$${picoToUsd(logs)}`,
      `$${picoToUsd(ledger)}`,
      ledger === logs ? "ok" : "MISMATCH",
      `${t1.instantCalls + (t2?.instantCalls ?? 0)} instant / ${t1.ownCalls + (t2?.ownCalls ?? 0)} own`,
    ]);
  }

  const header = ["lead", "status", "tier1 (logs)", "tier2 (logs)", "total (logs)", "ledger", "check", "calls"];
  const table = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...table.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join(" | ");
  console.log(`\n== Cost per lead (execution logs by session_id, last ${values.days} days) ==\n`);
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  for (const r of rows) console.log(line(r));

  const usage = await getComposio().experimental.usage.summary({ from, to });
  const avg = (total: Pico, n: number) => (n === 0 ? "-" : `$${picoToUsd(total / BigInt(n))}`);
  const summary = [
    `Leads with paid tier-1 calls: ${t1Leads} · avg tier-1 cost ${avg(t1Total, t1Leads)}`,
    `Leads with paid tier-2 calls: ${t2Leads} · avg tier-2 cost ${avg(t2Total, t2Leads)}`,
    `Sum from logs: $${picoToUsd(t1Total + t2Total)} · local ledger: $${picoToUsd(ledgerTotal)}`,
    `Project usage summary (instant_charge, same window): $${usage.instantCharge}`,
    `Unresolved reservations: ${store.reservations({ status: "unresolved" }).length}`,
  ];
  console.log("\n" + summary.join("\n"));
  console.log("\nNote: avg = integer pico-USD division (truncates below 1e-12). Anthropic token costs are not included.");

  mkdirSync("out", { recursive: true });
  const md = [`# Cost report (${new Date(to).toISOString()})`, "", `| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`), "", ...summary.map((s) => `- ${s}`)].join("\n");
  writeFileSync("out/cost_report.md", md + "\n");
  console.log("Written to out/cost_report.md");
  store.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
