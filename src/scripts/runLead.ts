// Push ONE lead through the full pipeline from the command line (tier 1, then
// tier 2 if it scores >= HOT_THRESHOLD). Prints the cost estimate and exits
// unless --yes is given.
//
//   npm run lead -- --email jane@acme.com --name "Jane Doe" [--company Acme] [--domain acme.com] [--source demo_booking]
//   npm run lead -- ... --tier1-only    # never run tier 2
//   npm run lead -- --research <leadId> --yes   # re-run only tier 2 for an existing lead
//   npm run lead -- ... --yes           # actually spend
//   npm run lead -- --header --yes      # write the CRM header row only (no Instant spend)
//   npm run lead -- --slack-test --yes  # post one test message to SLACK_CHANNEL (no Instant spend)

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createSession } from "../composio.js";
import { loadConfig } from "../config.js";
import { committedUsd, estimateLeads } from "../estimate.js";
import { SignupEventSchema } from "../lead.js";
import { picoToUsd } from "../money.js";
import { appendCrmHeader } from "../outputs/crm.js";
import { postSlack } from "../outputs/slack.js";
import { processLead, researchLead } from "../pipeline/processLead.js";
import type { Tier1Result } from "../pipeline/tier1.js";
import { Store } from "../store.js";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    company: { type: "string" },
    domain: { type: "string" },
    source: { type: "string", default: "manual" },
    "tier1-only": { type: "boolean", default: false },
    research: { type: "string" },
    header: { type: "boolean", default: false },
    "slack-test": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

async function main() {
  const cfg = loadConfig();
  const store = new Store(cfg.DB_PATH);

  if (values.header || values["slack-test"]) {
    const session = await createSession("outputs", { instantEnabled: false });
    if (values.header) console.log("header:", await appendCrmHeader(session));
    if (values["slack-test"]) console.log("slack:", await postSlack(session, "✅ Inbound enrichment agent connected. Hot-lead alerts will post here."));
    return;
  }

  if (values.research) {
    const rec = store.getLead(values.research);
    const stored = rec?.result as { lead?: unknown; tier1?: Tier1Result } | null | undefined;
    if (!rec || !stored?.tier1) throw new Error(`No tier-1 result stored for ${values.research}`);
    const lead = SignupEventSchema.parse(stored.lead ?? { event_id: rec.eventId, email: rec.email, source: "manual" });
    console.log(`Re-running tier 2 for ${rec.leadId} (${lead.email}); tier-2 budget $${cfg.TIER2_BUDGET_USD} per lead, already spent counts.`);
    console.log(`Ledger so far: $${committedUsd(store)} of $${cfg.DEV_SPEND_CAP_USD} cap`);
    if (!values.yes) return console.log("\nDry run. Re-run with --yes to spend.");
    const { tier2: t2, notes } = await researchLead(store, lead, rec.leadId, stored.tier1);
    console.log(`status:    ${t2.status} after ${t2.iterations} model turn(s), model ${t2.model}`);
    console.log(`tokens:    in ${t2.tokens.input} / out ${t2.tokens.output}`);
    console.log(`brief:     ${t2.brief ? JSON.stringify(t2.brief, null, 2) : t2.rawText.slice(0, 800)}`);
    console.log(`notes:     ${[...t2.notes, ...notes].join(" | ") || "-"}`);
    printCalls(t2.calls);
    console.log(`Tier-2 Instant cost (this lead, all research runs): $${t2.costUsd}`);
    return;
  }

  const lead = SignupEventSchema.parse({
    event_id: `cli_${randomUUID()}`,
    email: values.email,
    name: values.name,
    company_name: values.company,
    company_domain: values.domain,
    source: values.source,
  });

  const tier2 = !values["tier1-only"];
  const est = estimateLeads(1, { tier2 });
  console.log(`Lead: ${lead.email}`);
  console.log(`Estimated Instant cost: ~$${est.typicalUsd} typical tier 1; worst case $${est.worstUsd}${tier2 ? " (incl. tier-2 budget if it scores hot)" : ""}`);
  console.log(`Ledger so far: $${committedUsd(store)} of $${cfg.DEV_SPEND_CAP_USD} cap`);
  if (!values.yes) {
    console.log("\nDry run. Re-run with --yes to spend.");
    return;
  }

  const leadId = `lead_${randomUUID().slice(0, 8)}`;
  store.claimEvent({ eventId: lead.event_id, email: lead.email, leadId, dedupeWindowMs: 0 });
  const { tier1: t1, tier2: t2, notes } = await processLead(store, lead, leadId, { tier2 });

  console.log("\n== Tier 1 ==");
  console.log(`lead_id:   ${leadId}`);
  console.log(`session:   ${t1.sessionId}`);
  console.log(`status:    ${t1.status}  (provider: ${t1.enrichmentProvider ?? "-"})`);
  console.log(`email:     ${JSON.stringify(t1.email)}`);
  console.log(`domain:    ${t1.domain ?? "-"}`);
  console.log(`score:     ${t1.score ? `${t1.score.score} ${t1.score.tier}` : "-"}`);
  console.log(`summary:   ${t1.score?.summary ?? "-"}`);
  console.log(`news:      ${t1.news.length} items; homepage: ${t1.homepage ? `${t1.homepage.text.length} chars` : "none"}`);
  console.log(`crm:       ${JSON.stringify(t1.crm)}`);
  console.log(`slack:     ${JSON.stringify(t1.slack ?? "not sent (below hot threshold)")}`);
  console.log(`notes:     ${t1.notes.join(" | ") || "-"}`);
  printCalls(t1.calls);
  console.log(`Tier-1 Instant cost: $${t1.instantCostUsd}`);

  if (t2) {
    console.log("\n== Tier 2 ==");
    console.log(`session:   ${t2.sessionId}`);
    console.log(`status:    ${t2.status} after ${t2.iterations} model turn(s), model ${t2.model}`);
    console.log(`tokens:    in ${t2.tokens.input} / out ${t2.tokens.output}`);
    console.log(`brief:     ${t2.brief ? JSON.stringify(t2.brief, null, 2) : t2.rawText.slice(0, 800)}`);
    console.log(`notes:     ${[...t2.notes, ...notes].join(" | ") || "-"}`);
    printCalls(t2.calls);
    console.log(`Tier-2 Instant cost: $${t2.costUsd}`);
  } else {
    console.log("\nTier 2: not run (below threshold, tier1-only, or Instant disabled)");
  }
  store.close();
}

function printCalls(calls: { toolSlug: string; status: string; chargePico: bigint | null; credentialSource: string | null; note?: string }[]) {
  console.log("Instant calls:");
  for (const c of calls)
    console.log(
      `  ${c.toolSlug.padEnd(44)} ${c.status.padEnd(10)} charge=$${c.chargePico === null ? "?" : picoToUsd(c.chargePico)} source=${c.credentialSource ?? "?"}${c.note ? ` (${c.note})` : ""}`,
    );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
