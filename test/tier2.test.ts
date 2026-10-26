import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

// Tier-2 research loop with a scripted model and a fake Composio session:
// verifies interception, clamping, budget refusal and the forced final answer.

process.env.COMPOSIO_API_KEY = "test";
process.env.TIER2_BUDGET_USD = "0.01"; // fits one EXA_SEARCH ($0.007 bound), not two
process.env.TIER2_MAX_ITERATIONS = "4";

vi.mock("../src/composio.js", async (orig) => ({
  ...(await orig<typeof import("../src/composio.js")>()),
  getComposio: () => ({ logs: { get: async () => ({ metadata: {} }) } }),
}));

const { runTier2, clampArgs, briefMarkdown, briefCell } = await import("../src/pipeline/tier2.js");
const { Store } = await import("../src/store.js");
const { SignupEventSchema } = await import("../src/lead.js");

const BRIEF = {
  whatTheyDo: "Builds issue tracking",
  likelyUseCase: "Agents that triage issues",
  recentSignals: [{ signal: "Launched AI triage", source: "https://acme.io/blog" }],
  suggestedOpener: "Saw the AI triage launch.",
  sources: [{ title: "Blog", url: "https://acme.io/blog" }],
};

const tier1 = {
  leadId: "l1", status: "enriched", sessionId: "trs_1", email: {}, domain: "acme.io", person: null, company: { name: "Acme" },
  enrichmentProvider: "hunter", news: [], score: { score: 90, tier: "hot", fitReasons: [], risks: [], summary: "s" },
  instantCostUsd: "0.01", calls: [], notes: [],
} as unknown as Parameters<typeof runTier2>[0]["tier1"];

let n = 0;
const toolUse = (name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock =>
  ({ type: "tool_use", id: `tu_${++n}`, name, input }) as Anthropic.ToolUseBlock;
const message = (content: unknown[], stop: string): Anthropic.Message =>
  ({ id: "m", type: "message", role: "assistant", model: "x", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } }) as unknown as Anthropic.Message;
const text = (t: string) => ({ type: "text", text: t, citations: null });

function setup(script: Anthropic.Message[]) {
  const execute = vi.fn(async (slug: string, args: Record<string, unknown>) => ({
    data: { results: [{ url: "https://acme.io/blog", slug, args }] },
    error: null,
    logId: "log",
    resultType: "completed",
    instantCharge: { amount: slug === "EXA_SEARCH" ? "0.007" : "0.001", currency: "USD", charged_by: "composio" },
  }));
  const createMessage = vi.fn(async (_p: Anthropic.MessageCreateParamsNonStreaming) => script.shift()!);
  const deps = {
    createMessage,
    tools: async () =>
      ["EXA_SEARCH", "PARALLEL_SEARCH_WEB", "SLACK_SEND_MESSAGE"].map((name) => ({ name, description: "", input_schema: { type: "object" as const } })),
    // Mirrors AnthropicProvider.executeToolCall: run through the session, stringify data or error.
    executeToolCall: async (session: { execute: (s: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: string | null }> }, b: Anthropic.ToolUseBlock) => {
      const r = await session.execute(b.name, b.input as Record<string, unknown>);
      return JSON.stringify(r.error === null ? r.data : { error: r.error });
    },
  };
  return { execute, createMessage, deps, session: { sessionId: "trs_2", execute } };
}

const lead = SignupEventSchema.parse({ event_id: "e", email: "jane@acme.io" });

describe("runTier2", () => {
  it("gates each tool_use, refuses non-research tools, and parses the brief", async () => {
    const { execute, createMessage, deps, session } = setup([
      message([toolUse("EXA_SEARCH", { query: "acme ai", numResults: 50, type: "deep", contents: { text: true } })], "tool_use"),
      message([toolUse("SLACK_SEND_MESSAGE", { channel: "x", markdown_text: "hi" })], "tool_use"),
      message([text(JSON.stringify(BRIEF))], "end_turn"),
    ]);
    const r = await runTier2({ lead, leadId: "l1", tier1, session, store: new Store(":memory:"), instantEnabled: () => true, deps });

    expect(r.status).toBe("completed");
    expect(r.brief).toEqual(BRIEF);
    expect(r.costUsd).toBe("0.007");
    // Clamped before execution: Instant Exa = type auto, <=10 results, no inline contents.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![1]).toEqual({ query: "acme ai", numResults: 10, type: "auto" });
    // Slack was never executed; the model got an error tool_result instead.
    // (mock.calls holds a reference to the live messages array, so search all of it)
    expect(JSON.stringify(createMessage.mock.calls[2]![0].messages)).toContain("Tool SLACK_SEND_MESSAGE is not available");
    // The model never sees Sheets/Slack tools.
    expect(createMessage.mock.calls[0]![0].tools!.map((t) => (t as { name: string }).name)).toEqual(["EXA_SEARCH", "PARALLEL_SEARCH_WEB"]);
  });

  it("budget exhausted mid-run: refuses the call, then forces a final answer with tools off", async () => {
    const { execute, createMessage, deps, session } = setup([
      message([toolUse("EXA_SEARCH", { query: "a" })], "tool_use"),
      message([toolUse("EXA_SEARCH", { query: "b" })], "tool_use"),
      message([text(JSON.stringify(BRIEF))], "end_turn"),
    ]);
    const store = new Store(":memory:");
    const r = await runTier2({ lead, leadId: "l1", tier1, session, store, instantEnabled: () => true, deps });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("budget_exhausted");
    expect(r.brief).not.toBeNull();
    expect(createMessage.mock.calls[2]![0].tool_choice).toEqual({ type: "none" });
    expect(store.spentFor("l1:tier2")).toBe(7_000_000_000n);
  });

  it("iteration cap: stops looping and still produces a brief", async () => {
    const loop = Array.from({ length: 4 }, () => message([toolUse("PARALLEL_SEARCH_WEB", { search_queries: ["q"] })], "tool_use"));
    const { createMessage, deps, session } = setup([...loop, message([text("not json")], "end_turn")]);
    const r = await runTier2({ lead, leadId: "l1", tier1, session, store: new Store(":memory:"), instantEnabled: () => true, deps });
    expect(r.status).toBe("iterations_exhausted");
    expect(r.iterations).toBe(4);
    expect(createMessage).toHaveBeenCalledTimes(5);
    expect(r.brief).toBeNull();
    expect(briefCell(r)).toBe("not json");
  });

  it("a truncated final answer (max_tokens) is flagged, not silently lost", async () => {
    const cut = JSON.stringify(BRIEF).slice(0, 80);
    const { createMessage, deps, session } = setup([message([text(cut)], "max_tokens")]);
    const r = await runTier2({ lead, leadId: "l1", tier1, session, store: new Store(":memory:"), instantEnabled: () => true, deps });
    expect(r.brief).toBeNull();
    expect(r.notes).toContain("final answer hit max_tokens (truncated)");
    expect(createMessage.mock.calls[0]![0].max_tokens).toBeGreaterThanOrEqual(4000);
  });

  it("kill switch: no model call, no tool call", async () => {
    const { execute, createMessage, deps, session } = setup([]);
    const r = await runTier2({ lead, leadId: "l1", tier1, session, store: new Store(":memory:"), instantEnabled: () => false, deps });
    expect(r.status).toBe("instant_disabled");
    expect(createMessage).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("clampArgs", () => {
  it("keeps every call inside its reviewed price bound", () => {
    expect(clampArgs("PARALLEL_SEARCH_WEB", { search_queries: ["a", "b", "c", "d"], mode: "advanced" })).toEqual({ search_queries: ["a", "b", "c"], mode: "fast" });
    expect(clampArgs("EXA_GET_CONTENTS_ACTION", { ids: ["1", "2", "3", "4", "5", "6"], summary: true, highlights: true })).toEqual({
      urls: ["1", "2", "3", "4", "5"],
      text: { maxCharacters: 4000 },
    });
    expect(clampArgs("FIRECRAWL_SCRAPE", { url: "u", formats: ["json", "screenshot"], actions: [{}] })).toEqual({ url: "u", formats: ["markdown"], onlyMainContent: true });
    expect(clampArgs("FIRECRAWL_MAP_MULTIPLE_URLS_BASED_ON_OPTIONS", { url: "u", limit: 5000 })).toMatchObject({ limit: 100 });
  });
});

describe("brief formatting", () => {
  it("renders Slack markdown with cited sources", () => {
    const md = briefMarkdown({ brief: BRIEF, costUsd: "0.012", status: "completed", rawText: "" } as Parameters<typeof briefMarkdown>[0]);
    expect(md).toContain("tier-2 cost $0.012");
    expect(md).toContain("<https://acme.io/blog|[1]>");
  });
});
