import { beforeEach, describe, expect, it, vi } from "vitest";

// Branch coverage for the tier-1 pipeline with a fake Composio session and a
// fake scorer: exercises the real orchestration code without spending anything.

process.env.COMPOSIO_API_KEY = "test";
process.env.TIER1_BUDGET_USD = "0.05"; // Apollo's $0.18 bound can't fit, like the live test run
process.env.GOOGLE_SHEET_ID = "sheet_1";
process.env.SLACK_CHANNEL = "C123";

const score = vi.hoisted(() => ({ value: { score: 20, tier: "cold", fitReasons: [], risks: [], summary: "s" } as Record<string, unknown> }));

vi.mock("../src/pipeline/scoring.js", () => ({
  scoreLead: vi.fn(async () => ({ score: score.value, usage: { inputTokens: 0, outputTokens: 0 }, model: "fake" })),
}));
vi.mock("../src/composio.js", async (orig) => ({
  ...(await orig<typeof import("../src/composio.js")>()),
  assertInstantRouting: vi.fn(async () => undefined),
  getComposio: () => ({ logs: { get: async () => ({ metadata: { credential_source: "instant_account" } }) } }),
}));

const { runTier1 } = await import("../src/pipeline/tier1.js");
const { scoreLead } = await import("../src/pipeline/scoring.js");
const { Store } = await import("../src/store.js");
const { SignupEventSchema } = await import("../src/lead.js");

type Resp = { data: Record<string, unknown>; error: string | null; logId: string; resultType: string; instantCharge?: unknown };
const charged = (data: Record<string, unknown>, amount: string): Resp => ({
  data: { data },
  error: null,
  logId: "log",
  resultType: "completed",
  instantCharge: { amount, currency: "USD", charged_by: "composio" },
});
const failed = (error: string): Resp => ({ data: {}, error, logId: "log", resultType: "failed" });

function fakeSession(handlers: Record<string, (args: Record<string, unknown>) => Resp | Promise<Resp>>) {
  const execute = vi.fn(async (slug: string, args: Record<string, unknown>) => {
    const h = handlers[slug];
    if (!h) throw new Error(`unexpected tool ${slug}`);
    return h(args);
  });
  return { sessionId: "trs_test", execute } as unknown as Parameters<typeof runTier1>[0]["session"] & { execute: typeof execute };
}

const outputs = {
  GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND: () => ({ data: { updates: { updatedRange: "Leads!A2:U2" } }, error: null, logId: "l", resultType: "completed" }),
  SLACK_SEND_MESSAGE: () => ({ data: { ts: "1.2" }, error: null, logId: "l", resultType: "completed" }),
};
const validEmail = () => charged({ status: "valid", result: "deliverable", disposable: false, webmail: false }, "0.00598");
const lead = (over: Record<string, unknown> = {}) => SignupEventSchema.parse({ event_id: "e1", email: "jane@acme.io", ...over });
const slugs = (s: ReturnType<typeof fakeSession>) => s.execute.mock.calls.map((c) => c[0]);

beforeEach(() => {
  score.value = { score: 20, tier: "cold", fitReasons: [], risks: [], summary: "s" };
  vi.mocked(scoreLead).mockClear();
});

describe("runTier1", () => {
  it("disposable email: stops after validation, no scoring, still writes the CRM row", async () => {
    const s = fakeSession({ HUNTER_EMAIL_VERIFIER: () => charged({ status: "disposable", disposable: true }, "0.00598"), ...outputs });
    const r = await runTier1({ lead: lead(), leadId: "l1", session: s, store: new Store(":memory:"), instantEnabled: () => true });
    expect(r.status).toBe("rejected_email");
    expect(slugs(s)).toEqual(["HUNTER_EMAIL_VERIFIER", "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND"]);
    expect(scoreLead).not.toHaveBeenCalled();
    expect(r.instantCostUsd).toBe("0.00598");
  });

  it("hunter match: no Apollo, full research, cost summed exactly", async () => {
    const s = fakeSession({
      HUNTER_EMAIL_VERIFIER: validEmail,
      HUNTER_COMBINED_ENRICHMENT: () =>
        charged({ person: { name: { fullName: "Jane" }, employment: { title: "CTO", seniority: "executive" } }, company: { name: "Acme", metrics: { employees: 120 } } }, "0.002"),
      FIRECRAWL_SCRAPE: () => charged({ markdown: "# Acme builds AI agents", metadata: { title: "Acme" } }, "0.000798"),
      SERPER_SEARCH_NEWS: (args) => {
        expect(args.query).toBe('"Acme"');
        return charged({ articles: [{ title: "Acme raises Series A", link: "https://x" }] }, "0.0003");
      },
      ...outputs,
    });
    const r = await runTier1({ lead: lead(), leadId: "l1", session: s, store: new Store(":memory:"), instantEnabled: () => true });
    expect(r.status).toBe("enriched");
    expect(r.enrichmentProvider).toBe("hunter");
    expect(slugs(s)).not.toContain("APOLLO_PEOPLE_ENRICHMENT");
    expect(r.news).toHaveLength(1);
    expect(r.instantCostUsd).toBe("0.009078");
    const row = s.execute.mock.calls.find((c) => c[0] === "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND")![1].values as unknown[][];
    expect(row[0]).toContain("CTO");
    expect(row[0]).toContain("0.009078");
  });

  it("hunter miss with a company domain: Apollo refused by budget, research continues", async () => {
    const s = fakeSession({
      HUNTER_EMAIL_VERIFIER: validEmail,
      HUNTER_COMBINED_ENRICHMENT: () => failed("404 not found"),
      FIRECRAWL_SCRAPE: () => charged({ markdown: "home" }, "0.000798"),
      SERPER_SEARCH_NEWS: () => charged({ articles: [] }, "0.0003"),
      ...outputs,
    });
    const r = await runTier1({ lead: lead(), leadId: "l1", session: s, store: new Store(":memory:"), instantEnabled: () => true });
    expect(slugs(s)).not.toContain("APOLLO_PEOPLE_ENRICHMENT");
    expect(slugs(s)).toContain("FIRECRAWL_SCRAPE");
    expect(r.notes.some((n) => n.startsWith("apollo skipped"))).toBe(true);
    expect(r.status).toBe("partial");
  });

  it("free-mail with no submitted domain: no Apollo, no scrape, no news", async () => {
    const s = fakeSession({ HUNTER_EMAIL_VERIFIER: validEmail, HUNTER_COMBINED_ENRICHMENT: () => failed("no match"), ...outputs });
    const r = await runTier1({ lead: lead({ email: "jane@gmail.com" }), leadId: "l1", session: s, store: new Store(":memory:"), instantEnabled: () => true });
    expect(slugs(s)).toEqual(["HUNTER_EMAIL_VERIFIER", "HUNTER_COMBINED_ENRICHMENT", "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND"]);
    expect(r.domain).toBeUndefined();
  });

  it("402 on a demo booking: marked unenriched, CRM row + Slack alert still sent", async () => {
    const s = fakeSession({
      HUNTER_EMAIL_VERIFIER: () => Promise.reject(Object.assign(new Error("402"), { status: 402 })),
      ...outputs,
    });
    const r = await runTier1({ lead: lead({ source: "demo_booking" }), leadId: "l1", session: s, store: new Store(":memory:"), instantEnabled: () => true });
    expect(r.status).toBe("unenriched");
    expect(slugs(s)).toEqual(["HUNTER_EMAIL_VERIFIER", "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", "SLACK_SEND_MESSAGE"]);
    expect(r.instantCostUsd).toBe("0.00");
  });

  it("kill switch: zero paid calls, still scored and written", async () => {
    const s = fakeSession({ ...outputs });
    const r = await runTier1({ lead: lead(), leadId: "l1", session: s, store: new Store(":memory:"), instantEnabled: () => false });
    expect(r.status).toBe("instant_disabled");
    expect(slugs(s)).toEqual(["GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND"]);
    expect(scoreLead).toHaveBeenCalledOnce();
  });

  it("hot lead: Slack alert includes score and CRM link", async () => {
    score.value = { score: 88, tier: "hot", fitReasons: ["CTO at AI startup"], risks: [], summary: "Strong fit." };
    const s = fakeSession({
      HUNTER_EMAIL_VERIFIER: validEmail,
      HUNTER_COMBINED_ENRICHMENT: () => charged({ person: { name: { fullName: "Jane" } }, company: { name: "Acme" } }, "0.002"),
      FIRECRAWL_SCRAPE: () => charged({ markdown: "x" }, "0.000798"),
      SERPER_SEARCH_NEWS: () => charged({ articles: [] }, "0.0003"),
      ...outputs,
    });
    const r = await runTier1({ lead: lead(), leadId: "l1", session: s, store: new Store(":memory:"), instantEnabled: () => true });
    const msg = s.execute.mock.calls.find((c) => c[0] === "SLACK_SEND_MESSAGE")![1].markdown_text as string;
    expect(r.slack).toEqual({ ok: true, ts: "1.2" });
    expect(msg).toContain("88/100");
    expect(msg).toContain("docs.google.com/spreadsheets/d/sheet_1");
  });

  it("CRM/Slack errors don't crash the run after money was spent", async () => {
    score.value = { score: 90, tier: "hot", fitReasons: [], risks: [], summary: "s" };
    const s = fakeSession({
      HUNTER_EMAIL_VERIFIER: validEmail,
      HUNTER_COMBINED_ENRICHMENT: () => charged({ person: { name: "J" } }, "0.002"),
      FIRECRAWL_SCRAPE: () => charged({ markdown: "x" }, "0.000798"),
      SERPER_SEARCH_NEWS: () => charged({ articles: [] }, "0.0003"),
      GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND: () => Promise.reject(Object.assign(new Error("400"), { status: 400 })),
      SLACK_SEND_MESSAGE: () => ({ data: {}, error: "not_in_channel", logId: "l", resultType: "failed" }),
    });
    const r = await runTier1({ lead: lead(), leadId: "l1", session: s, store: new Store(":memory:"), instantEnabled: () => true });
    expect(r.crm?.ok).toBe(false);
    expect(r.slack).toEqual({ ok: false, error: "not_in_channel" });
  });
});
