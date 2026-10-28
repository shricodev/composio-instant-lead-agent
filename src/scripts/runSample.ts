// Push sample leads from data/sample_leads.json through the full pipeline.
// Goes through the same idempotency claim as the webhook, so re-running the
// script does not re-spend on leads already processed.
//
//   npm run sample                 # estimate only (first lead)
//   npm run sample -- --limit 3    # estimate for 3 leads
//   npm run sample -- --limit 3 --yes

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { committedUsd, estimateLeads } from "../estimate.js";
import { SignupEventSchema } from "../lead.js";
import { usdToPico } from "../money.js";
import { processLead } from "../pipeline/processLead.js";
import { Store } from "../store.js";

const { values } = parseArgs({
  options: {
    limit: { type: "string", default: "1" },
    "tier1-only": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

async function main() {
  const cfg = loadConfig();
  const store = new Store(cfg.DB_PATH);
  const all = z.array(SignupEventSchema).parse(JSON.parse(readFileSync(new URL("../../data/sample_leads.json", import.meta.url), "utf8")));
  const leads = all.slice(0, Math.max(1, Number(values.limit)));
  const tier2 = !values["tier1-only"];

  const est = estimateLeads(leads.length, { tier2 });
  const committed = committedUsd(store);
  console.log(`${leads.length} lead(s): ${leads.map((l) => l.email).join(", ")}`);
  console.log(`Estimated Instant cost: ~$${est.typicalUsd} typical (tier 1); worst case $${est.worstUsd}${tier2 ? " incl. tier 2" : ""}`);
  console.log(`Ledger so far: $${committed} of $${cfg.DEV_SPEND_CAP_USD} cap`);
  if (usdToPico(committed) + est.worstPico > usdToPico(cfg.DEV_SPEND_CAP_USD))
    console.log("! Worst case exceeds the cap: the budget gate will refuse calls once the cap is reached.");
  if (!values.yes) {
    console.log("\nDry run. Re-run with --yes to spend.");
    return;
  }

  for (const lead of leads) {
    const claim = store.claimEvent({ eventId: lead.event_id, email: lead.email, leadId: `lead_${randomUUID().slice(0, 8)}`, dedupeWindowMs: cfg.DEDUPE_WINDOW_MINUTES * 60_000 });
    if (claim.duplicate) {
      console.log(`- ${lead.email}: duplicate (${claim.reason}) of ${claim.leadId}, skipped`);
      continue;
    }
    try {
      const r = await processLead(store, lead, claim.leadId, { tier2 });
      console.log(
        `- ${lead.email}: ${r.tier1.status} score=${r.tier1.score?.score ?? "-"} tier1=$${r.tier1.instantCostUsd}` +
          (r.tier2 ? ` tier2=$${r.tier2.costUsd} (${r.tier2.status})` : "") +
          ` lead=${claim.leadId}`,
      );
    } catch (err) {
      console.log(`- ${lead.email}: FAILED ${String(err).slice(0, 200)}`);
    }
  }
  console.log(`\nLedger now: $${committedUsd(store)}`);
  store.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
