// Single source of truth for every Composio tool this service calls.
// discoverTools.ts checks each entry against the live catalog; the session
// policies in composio.ts are derived from these lists, so the agent can never
// see (or pay for) a tool that isn't declared here.

export type ToolSpec = {
  slug: string;
  toolkit: string;
  purpose: string;
  /** "instant" = paid via the wallet; "own" = runs on the user's OAuth connection. */
  credential: "instant" | "own";
};

export const TIER1_TOOLS: ToolSpec[] = [
  { slug: "HUNTER_EMAIL_VERIFIER", toolkit: "hunter", purpose: "Email validation", credential: "instant" },
  { slug: "HUNTER_COMBINED_ENRICHMENT", toolkit: "hunter", purpose: "Person + company enrichment", credential: "instant" },
  { slug: "APOLLO_PEOPLE_ENRICHMENT", toolkit: "apollo", purpose: "Enrichment fallback when Hunter has no match", credential: "instant" },
  { slug: "FIRECRAWL_SCRAPE", toolkit: "firecrawl", purpose: "Homepage scrape", credential: "instant" },
  { slug: "SERPER_SEARCH_NEWS", toolkit: "serper", purpose: "Recent company news", credential: "instant" },
];

export const TIER2_TOOLS: ToolSpec[] = [
  { slug: "PARALLEL_SEARCH_WEB", toolkit: "parallel", purpose: "Deep research web search", credential: "instant" },
  { slug: "EXA_SEARCH", toolkit: "exa", purpose: "Semantic web search", credential: "instant" },
  { slug: "EXA_GET_CONTENTS_ACTION", toolkit: "exa", purpose: "Fetch page contents for Exa results", credential: "instant" },
  { slug: "FIRECRAWL_SCRAPE", toolkit: "firecrawl", purpose: "Scrape a cited page", credential: "instant" },
  { slug: "FIRECRAWL_MAP_MULTIPLE_URLS_BASED_ON_OPTIONS", toolkit: "firecrawl", purpose: "Map a company site", credential: "instant" },
];

// Slugs confirmed by `npm run discover -- --sweep` (see BUILD_NOTES.md).
export const OUTPUT_TOOLS: ToolSpec[] = [
  { slug: "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", toolkit: "googlesheets", purpose: "Append CRM row", credential: "own" },
  { slug: "GOOGLESHEETS_UPDATE_VALUES_BATCH", toolkit: "googlesheets", purpose: "Add tier-2 brief to the CRM row", credential: "own" },
  { slug: "SLACK_SEND_MESSAGE", toolkit: "slack", purpose: "Hot-lead alert", credential: "own" },
];

export const ALL_TOOLS: ToolSpec[] = dedupe([...TIER1_TOOLS, ...TIER2_TOOLS, ...OUTPUT_TOOLS]);

function dedupe(tools: ToolSpec[]): ToolSpec[] {
  const seen = new Map<string, ToolSpec>();
  for (const t of tools) if (!seen.has(t.slug)) seen.set(t.slug, t);
  return [...seen.values()];
}

/** Group Instant-paid slugs by toolkit, for the session's per-tool allowlist. */
export function instantToolsByToolkit(tools: ToolSpec[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of tools) {
    if (t.credential !== "instant") continue;
    (out[t.toolkit] ??= []).push(t.slug);
  }
  return out;
}
