import { BudgetExceededError, BudgetedExecutor, InstantDisabledError, WalletExhaustedError, type LogLookup } from "../budget.js";
import { assertInstantRouting, getComposio, type LeadSession } from "../composio.js";
import { loadConfig } from "../config.js";
import { companyDomain } from "../domain.js";
import { isDemoBooking, type SignupEvent } from "../lead.js";
import { picoToUsd } from "../money.js";
import { appendCrmRow, type CrmRow, type CrmWriteResult } from "../outputs/crm.js";
import { postSlack, type SlackResult } from "../outputs/slack.js";
import { loadPriceBounds } from "../priceBounds.js";
import type { Store } from "../store.js";
import { TIER1_TOOLS } from "../tools.js";
import { scoreLead, type LeadScore } from "./scoring.js";

// Tier 1: a fixed, deterministic sequence of Instant calls for EVERY lead.
// No LLM has tool access here, so the cost per lead is bounded by the sum of
// the reviewed price bounds and enforced by BudgetedExecutor.

export type EnrichmentStatus =
  | "enriched"
  | "partial" // some steps skipped (no domain, no match, or tier budget hit)
  | "rejected_email" // invalid or disposable: stopped before spending more
  | "unenriched" // wallet exhausted (402)
  | "instant_disabled"; // kill switch on

export type Tier1Result = {
  leadId: string;
  status: EnrichmentStatus;
  sessionId: string;
  email: { status?: string; result?: string; disposable?: boolean; webmail?: boolean; score?: number };
  domain?: string;
  person: Record<string, unknown> | null;
  company: Record<string, unknown> | null;
  enrichmentProvider: "hunter" | "apollo" | null;
  homepage?: { title?: string; description?: string; text: string };
  news: { title: string; source?: string; date?: string; link?: string; snippet?: string }[];
  score: LeadScore | null;
  scoringModel?: string;
  instantCostUsd: string;
  calls: BudgetedExecutor["calls"];
  notes: string[];
  crm?: CrmWriteResult;
  slack?: SlackResult;
};

const HOMEPAGE_CHARS = 3000;
const NEWS_ITEMS = 5;

/** Most tool payloads nest the provider body under `data`; unwrap one level if so. */
function body(data: Record<string, unknown>): Record<string, unknown> {
  const inner = data.data;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : data;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export const logLookup: LogLookup = async (logId) => {
  const log = await getComposio().logs.get(logId);
  const meta = (log as { metadata?: Record<string, unknown> }).metadata ?? {};
  return {
    ...(typeof meta.instant_charge === "string" ? { instantCharge: meta.instant_charge } : {}),
    ...(typeof meta.credential_source === "string" ? { credentialSource: meta.credential_source } : {}),
  };
};

export async function runTier1(input: {
  lead: SignupEvent;
  leadId: string;
  session: LeadSession;
  store: Store;
  instantEnabled: () => boolean;
}): Promise<Tier1Result> {
  const cfg = loadConfig();
  const { lead, leadId, session, store } = input;
  const ex = new BudgetedExecutor({
    store,
    executor: session,
    logLookup,
    bounds: loadPriceBounds(),
    leadId,
    runKey: `${leadId}:tier1`,
    sessionId: session.sessionId,
    runBudgetUsd: cfg.TIER1_BUDGET_USD,
    globalCapUsd: cfg.DEV_SPEND_CAP_USD,
    instantEnabled: input.instantEnabled,
    explicitAccount: cfg.INSTANT_EXPLICIT_ACCOUNT,
  });

  const r: Tier1Result = {
    leadId,
    status: "enriched",
    sessionId: session.sessionId,
    email: {},
    person: null,
    company: null,
    enrichmentProvider: null,
    news: [],
    score: null,
    instantCostUsd: "0.00",
    calls: ex.calls,
    notes: [],
  };

  try {
    if (input.instantEnabled()) await assertInstantRouting(session, [...new Set(TIER1_TOOLS.map((t) => t.toolkit))]);
    await enrich(lead, ex, r);
  } catch (err) {
    if (err instanceof WalletExhaustedError) {
      r.status = "unenriched";
      r.notes.push(`wallet exhausted at ${err.toolSlug}; remaining Instant steps skipped`);
    } else if (err instanceof InstantDisabledError) {
      r.status = "instant_disabled";
      r.notes.push("kill switch on; Instant steps skipped");
    } else if (err instanceof BudgetExceededError) {
      r.status = "partial";
      r.notes.push(err.message);
    } else {
      throw err;
    }
  }

  // Score whatever we have, unless the email was rejected (no point paying for tokens).
  // From here on we've already paid for enrichment: no single failure may lose the lead.
  if (r.status !== "rejected_email") {
    try {
      const scored = await scoreLead(scoringInput(lead, r));
      r.score = scored.score;
      r.scoringModel = scored.model;
    } catch (err) {
      r.notes.push(`scoring failed: ${errText(err)}`);
    }
  }

  r.instantCostUsd = picoToUsd(store.spentFor(`${leadId}:tier1`));
  r.crm = await appendCrmRow(session, crmRow(lead, r)).catch((err: unknown) => ({ ok: false as const, error: errText(err) }));
  if (!r.crm.ok) r.notes.push(`CRM write failed: ${r.crm.error}`);

  const unenrichedBooking = (r.status === "unenriched" || r.status === "instant_disabled") && isDemoBooking(lead);
  const hot = (r.score?.score ?? 0) >= cfg.HOT_THRESHOLD;
  if (hot || unenrichedBooking) {
    r.slack = await postSlack(session, slackMessage(lead, r)).catch((err: unknown) => ({ ok: false as const, error: errText(err) }));
    if (!r.slack.ok) r.notes.push(`Slack alert failed: ${r.slack.error}`);
  }
  return r;
}

async function enrich(lead: SignupEvent, ex: BudgetedExecutor, r: Tier1Result): Promise<void> {
  // 1. Validate the email first: invalid/disposable addresses stop here.
  const v = await ex.execute("HUNTER_EMAIL_VERIFIER", { email: lead.email });
  const vb = body(v.data);
  r.email = {
    status: str(vb.status),
    result: str(vb.result),
    disposable: vb.disposable === true,
    webmail: vb.webmail === true,
    score: typeof vb.score === "number" ? vb.score : undefined,
  };
  if (v.error) r.notes.push(`email verifier error: ${v.error}`);
  if (r.email.disposable || r.email.status === "invalid" || r.email.result === "undeliverable") {
    r.status = "rejected_email";
    r.notes.push(`email rejected (status=${r.email.status}, disposable=${r.email.disposable})`);
    return;
  }

  // 2. Company domain: email domain unless free-mail, else the submitted field.
  const d = companyDomain(lead.email, lead.company_domain);
  r.domain = d.domain;
  if (!d.domain) r.notes.push("no company domain (free-mail address and none submitted)");

  // 3. Person + company. Hunter first ($0.004); Apollo ($0.02–0.18) only if Hunter has nothing.
  const h = await ex.execute("HUNTER_COMBINED_ENRICHMENT", { email: lead.email });
  const hb = body(h.data);
  r.person = obj(hb.person);
  r.company = obj(hb.company);
  if (r.person || r.company) r.enrichmentProvider = "hunter";
  else if (!d.domain) {
    // A free-mail address with no company: Apollo would cost up to $0.18 to (likely) find nothing.
    r.notes.push("hunter: no match; apollo skipped (no company domain)");
  } else {
    r.notes.push(`hunter: no match${h.error ? ` (${h.error.slice(0, 120)})` : ""}; trying apollo`);
    try {
      const a = await ex.execute("APOLLO_PEOPLE_ENRICHMENT", {
        email: lead.email,
        ...(lead.name ? { name: lead.name } : {}),
        domain: d.domain,
        ...(lead.company_name ? { organization_name: lead.company_name } : {}),
        reveal_personal_emails: false,
        reveal_phone_number: false,
      });
      const ab = body(a.data);
      r.person = obj(ab.person);
      r.company = obj(ab.organization) ?? obj(obj(ab.person)?.organization);
      if (r.person || r.company) r.enrichmentProvider = "apollo";
      else r.notes.push("apollo: no match");
    } catch (err) {
      // The fallback is optional: if the budget can't cover it, carry on with research.
      if (!(err instanceof BudgetExceededError)) throw err;
      r.notes.push(`apollo skipped: ${err.message}`);
    }
  }

  const domain = r.domain ?? str(r.company?.domain);
  r.domain = domain;
  const companyName = str(r.company?.name) ?? lead.company_name;

  // 4. Homepage: what does the company actually do?
  if (domain) {
    const s = await ex.execute("FIRECRAWL_SCRAPE", {
      url: `https://${domain}`,
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 20000,
    });
    const sb = body(s.data);
    const meta = obj(sb.metadata) ?? {};
    const md = str(sb.markdown);
    if (md) r.homepage = { title: str(meta.title), description: str(meta.description), text: md.slice(0, HOMEPAGE_CHARS) };
    else r.notes.push(`homepage scrape empty${s.error ? `: ${s.error.slice(0, 120)}` : ""}`);
  }

  // 5. Recent news signals (funding, launches, hiring).
  if (companyName || domain) {
    const n = await ex.execute("SERPER_SEARCH_NEWS", { query: companyName ? `"${companyName}"` : domain! });
    const articles = body(n.data).articles;
    if (Array.isArray(articles)) {
      r.news = articles.slice(0, NEWS_ITEMS).map((a) => {
        const o = obj(a) ?? {};
        return { title: str(o.title) ?? "", source: str(o.source), date: str(o.date), link: str(o.link), snippet: str(o.snippet) };
      });
    }
  }

  if (!r.person && !r.company) r.status = "partial";
}

function errText(err: unknown): string {
  const e = err as { details?: { message?: string }; message?: string };
  return (e?.details?.message ?? e?.message ?? String(err)).slice(0, 300);
}

function scoringInput(lead: SignupEvent, r: Tier1Result) {
  const p = r.person ?? {};
  const employment = obj(p.employment) ?? {};
  return {
    submitted: { name: lead.name, email: lead.email, company_name: lead.company_name, company_domain: lead.company_domain, source: lead.source },
    emailCheck: r.email,
    domain: r.domain,
    person: r.person
      ? {
          name: obj(p.name)?.fullName ?? p.name,
          title: employment.title ?? p.title,
          seniority: employment.seniority ?? p.seniority,
          role: employment.role,
          location: p.location ?? p.city,
          bio: p.bio ?? p.headline,
        }
      : null,
    company: r.company
      ? {
          name: r.company.name,
          description: r.company.description ?? r.company.short_description,
          category: r.company.category ?? r.company.industry,
          employees: obj(r.company.metrics)?.employees ?? r.company.estimated_num_employees,
          raised: obj(r.company.metrics)?.raised ?? r.company.total_funding,
          foundedYear: r.company.foundedYear ?? r.company.founded_year,
          tags: r.company.tags ?? r.company.keywords,
          type: r.company.type,
        }
      : null,
    homepage: r.homepage,
    news: r.news,
    enrichmentStatus: r.status,
  };
}

function crmRow(lead: SignupEvent, r: Tier1Result): CrmRow {
  const s = scoringInput(lead, r);
  const text = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" || typeof v === "number" ? v : JSON.stringify(v));
  return {
    received_at: new Date().toISOString(),
    lead_id: r.leadId,
    source: lead.source,
    email: lead.email,
    name: text(s.person?.name) ?? lead.name ?? null,
    company: text(s.company?.name) ?? lead.company_name ?? null,
    domain: r.domain ?? null,
    title: text(s.person?.title),
    seniority: text(s.person?.seniority),
    company_size: text(s.company?.employees),
    industry: text(obj(s.company?.category)?.industry ?? s.company?.category),
    score: r.score?.score ?? null,
    tier: r.score?.tier ?? null,
    summary: r.score?.summary ?? null,
    fit_reasons: r.score?.fitReasons.join("; ") ?? null,
    risks: r.score?.risks.join("; ") ?? null,
    enrichment_status: r.status,
    enrichment_provider: r.enrichmentProvider,
    instant_cost_usd: r.instantCostUsd,
  };
}

function slackMessage(lead: SignupEvent, r: Tier1Result): string {
  const who = [lead.name, lead.email].filter(Boolean).join(" · ");
  const head =
    r.score && r.score.score >= loadConfig().HOT_THRESHOLD
      ? `🔥 *Hot lead* (${r.score.score}/100): ${who}`
      : `📅 *Demo booked*, enrichment unavailable (${r.status}): ${who}`;
  const lines = [head];
  if (r.domain) lines.push(`Company: ${r.domain}`);
  if (r.score) {
    lines.push(r.score.summary);
    if (r.score.fitReasons.length) lines.push(`*Why:* ${r.score.fitReasons.join("; ")}`);
    if (r.score.risks.length) lines.push(`*Risks:* ${r.score.risks.join("; ")}`);
  }
  lines.push(`Instant cost: $${r.instantCostUsd}${r.crm?.ok ? ` · <${r.crm.url}|CRM row>` : ""}`);
  return lines.join("\n");
}
