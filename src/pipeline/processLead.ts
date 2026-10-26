import { createSession } from "../composio.js";
import { loadConfig } from "../config.js";
import { isInstantEnabled, trackSession } from "../killSwitch.js";
import type { SignupEvent } from "../lead.js";
import { updateResearch } from "../outputs/crm.js";
import { postSlack } from "../outputs/slack.js";
import type { Store } from "../store.js";
import { runTier1, type Tier1Result } from "./tier1.js";
import { briefCell, briefMarkdown, runTier2, type Tier2Result } from "./tier2.js";

// One lead, end to end. Session-per-run: tier 1 and tier 2 each get their own
// Composio session, persisted on the lead, so per-lead cost reconciles directly
// from the execution logs by session_id.

export type ProcessResult = { leadId: string; tier1: Tier1Result; tier2?: Tier2Result; notes: string[] };

export function shouldRunTier2(t1: Tier1Result, threshold: number): boolean {
  return (t1.status === "enriched" || t1.status === "partial") && (t1.score?.score ?? 0) >= threshold;
}

export async function processLead(store: Store, lead: SignupEvent, leadId: string, opts: { tier2?: boolean } = {}): Promise<ProcessResult> {
  const cfg = loadConfig();
  const instantEnabled = () => isInstantEnabled(store);
  const notes: string[] = [];
  const base = { leadId, eventId: lead.event_id, email: lead.email };

  store.upsertLead({ ...base, status: "processing" });
  try {
    const s1 = await createSession("tier1", { instantEnabled: instantEnabled() });
    store.upsertLead({ ...base, status: "processing", tier1SessionId: s1.sessionId });
    const untrack1 = trackSession(s1.sessionId, "tier1");
    const tier1 = await runTier1({ lead, leadId, session: s1, store, instantEnabled }).finally(untrack1);
    store.upsertLead({ ...base, status: tier1.status, result: { lead, tier1 } });

    if (opts.tier2 === false || !shouldRunTier2(tier1, cfg.HOT_THRESHOLD) || !instantEnabled()) {
      store.upsertLead({ ...base, status: `done:${tier1.status}` });
      return { leadId, tier1, notes };
    }

    const { tier2, notes: researchNotes } = await researchLead(store, lead, leadId, tier1);
    notes.push(...researchNotes);
    return { leadId, tier1, tier2, notes };
  } catch (err) {
    store.upsertLead({ ...base, status: "failed", result: { error: String(err).slice(0, 500) } });
    throw err;
  }
}

/**
 * Tier 2 + its outputs for a lead that already has a tier-1 result. Also used
 * on its own to re-run research for an existing lead (`npm run lead -- --research <leadId>`).
 */
export async function researchLead(store: Store, lead: SignupEvent, leadId: string, tier1: Tier1Result): Promise<{ tier2: Tier2Result; notes: string[] }> {
  const notes: string[] = [];
  const base = { leadId, eventId: lead.event_id, email: lead.email };
  const instantEnabled = () => isInstantEnabled(store);

  const s2 = await createSession("tier2");
  store.upsertLead({ ...base, status: "researching", tier2SessionId: s2.sessionId });
  const untrack2 = trackSession(s2.sessionId, "tier2");
  const tier2 = await runTier2({ lead, leadId, tier1, session: s2, store, instantEnabled }).finally(untrack2);

  // Outputs run on the workspace's own accounts; failures are noted, never fatal.
  if (tier1.crm?.ok && tier1.crm.updatedRange) {
    const crm = await updateResearch(s2, tier1.crm.updatedRange, tier2.costUsd, briefCell(tier2)).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
    if (!crm.ok) notes.push(`CRM research update failed: ${crm.error}`);
  } else notes.push("CRM row unknown; research brief not written to the sheet");

  const slack = await postSlack(s2, briefMarkdown(tier2), tier1.slack?.ok ? tier1.slack.ts : undefined).catch((e: unknown) => ({
    ok: false as const,
    error: String(e),
  }));
  if (!slack.ok) notes.push(`Slack brief failed: ${slack.error}`);

  store.upsertLead({ ...base, status: `done:${tier1.status}+research:${tier2.status}`, result: { lead, tier1, tier2, notes } });
  return { tier2, notes };
}
