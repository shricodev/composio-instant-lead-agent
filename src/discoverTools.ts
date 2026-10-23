// Discovery: verify every tool we plan to call is Instant-eligible on the latest
// toolkit version, print its published price next to our reviewed bound, and
// flag connected accounts that would silently hijack Instant routing.
//
// Only metadata endpoints are called here; this script spends nothing.
//
//   npm run discover            # table + checks, exits 1 on any problem
//   npm run discover -- --sweep # also list every Instant tool in the toolkits we use

import { mkdirSync, writeFileSync } from "node:fs";
import { getComposio } from "./composio.js";
import { loadConfig } from "./config.js";
import { loadPriceBounds } from "./priceBounds.js";
import { ALL_TOOLS, type ToolSpec } from "./tools.js";

type InstantInfo = {
  supported?: boolean;
  price?: { description?: string | null; discount?: string | null } | null;
} | null;

type ToolRow = {
  slug: string;
  name?: string;
  toolkit?: { slug?: string };
  version?: string;
  instant?: InstantInfo;
};

type ToolListPage = { items: ToolRow[]; next_cursor?: string | null };

const SWEEP_TOOLKITS = ["hunter", "zerobounce", "apollo", "firecrawl", "serper", "parallel", "exa"];
const TRIGGER_SLUG = "CALENDLY_MEETING_SCHEDULED";

async function getTool(slug: string): Promise<ToolRow | { error: string }> {
  try {
    return await getComposio()
      .getClient()
      .get<ToolRow>(`/api/v3.1/tools/${slug}`, {
        query: { toolkit_versions: "latest", include_pricing: true },
      });
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/** Every tool in a toolkit, following next_cursor through ALL pages. */
async function listToolkitTools(toolkit: string): Promise<ToolRow[]> {
  const out: ToolRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await getComposio()
      .getClient()
      .get<ToolListPage>("/api/v3.1/tools", {
        query: {
          toolkit_slug: toolkit,
          toolkit_versions: "latest",
          include_pricing: true,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        },
      });
    out.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status?: number; message?: string };
    return `HTTP ${e.status}: ${e.message ?? ""}`.slice(0, 160);
  }
  return err instanceof Error ? err.message : String(err);
}

function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  const width = (c: string) => Math.min(70, Math.max(c.length, ...rows.map((r) => (r[c] ?? "").length)));
  const fmt = (r: Record<string, string>) =>
    cols.map((c) => (r[c] ?? "").slice(0, width(c)).padEnd(width(c))).join(" | ");
  console.log(fmt(Object.fromEntries(cols.map((c) => [c, c]))));
  console.log(cols.map((c) => "-".repeat(width(c))).join("-|-"));
  for (const r of rows) console.log(fmt(r));
}

async function checkPlannedTools(problems: string[]) {
  const bounds = loadPriceBounds();
  const results = await Promise.all(ALL_TOOLS.map(async (spec) => ({ spec, tool: await getTool(spec.slug) })));

  const rows = results.map(({ spec, tool }) => {
    if ("error" in tool) {
      problems.push(`${spec.slug}: lookup failed (${tool.error})`);
      return { slug: spec.slug, credential: spec.credential, instant: "LOOKUP FAILED", price: tool.error, discount: "", bound: "" };
    }
    const supported = tool.instant?.supported === true;
    const desc = tool.instant?.price?.description ?? "";
    const bound = bounds[spec.slug];

    if (spec.credential === "instant") {
      if (!supported) problems.push(`${spec.slug}: NOT Instant-eligible on latest version (${tool.version ?? "?"})`);
      if (!bound) problems.push(`${spec.slug}: no reviewed price bound in data/tool_price_bounds.json`);
      else if (bound.reviewedDescription !== desc)
        problems.push(`${spec.slug}: published price changed since review:\n      was: ${bound.reviewedDescription}\n      now: ${desc}`);
      if (supported && !desc) console.warn(`  ! ${spec.slug}: no published price (missing pricing is NOT free)`);
    }
    return {
      slug: spec.slug,
      credential: spec.credential,
      instant: supported ? "yes" : "no",
      price: desc || "(none published)",
      discount: tool.instant?.price?.discount ?? "",
      bound: bound ? `$${bound.maxUsd}` : "-",
    };
  });

  console.log("\n== Planned tools (latest toolkit versions) ==\n");
  printTable(rows);
  return results;
}

async function sweepToolkits() {
  console.log("\n== Instant-eligible tools per toolkit (all pages) ==");
  const sweep: Record<string, { slug: string; price: string }[]> = {};
  for (const tk of SWEEP_TOOLKITS) {
    try {
      const tools = await listToolkitTools(tk);
      const instant = tools.filter((t) => t.instant?.supported === true);
      sweep[tk] = instant.map((t) => ({ slug: t.slug, price: t.instant?.price?.description ?? "" }));
      console.log(`\n[${tk}] ${instant.length}/${tools.length} tools Instant-eligible`);
      for (const t of sweep[tk]) console.log(`  ${t.slug.padEnd(48)} ${t.price}`);
    } catch (err) {
      console.log(`\n[${tk}] list failed: ${errorMessage(err)}`);
    }
  }

  // Output tools run on the user's own OAuth: find exact slugs for "append row" / "post message".
  for (const [tk, pattern] of [
    ["googlesheets", /APPEND|BATCH_UPDATE|CREATE_SPREADSHEET_ROW/],
    ["slack", /SEND_MESSAGE|POST_MESSAGE|CHAT_POST/],
  ] as const) {
    try {
      const tools = await listToolkitTools(tk);
      console.log(`\n[${tk}] candidate output tools (${tools.length} total):`);
      for (const t of tools.filter((t) => pattern.test(t.slug))) console.log(`  ${t.slug}`);
    } catch (err) {
      console.log(`\n[${tk}] list failed: ${errorMessage(err)}`);
    }
  }
  return sweep;
}

async function checkConnections(problems: string[]) {
  const cfg = loadConfig();
  const instantToolkits = new Set(ALL_TOOLS.filter((t) => t.credential === "instant").map((t) => t.toolkit));
  const ownToolkits = new Set(ALL_TOOLS.filter((t) => t.credential === "own").map((t) => t.toolkit));

  const res = await getComposio().connectedAccounts.list({ userIds: [cfg.COMPOSIO_USER_ID], limit: 100 });
  console.log(`\n== Connected accounts for user "${cfg.COMPOSIO_USER_ID}" ==`);
  if (res.items.length === 0) console.log("  (none)");
  for (const acc of res.items) {
    const tk = acc.toolkit.slug;
    const tag = instantToolkits.has(tk)
      ? "HIJACK RISK: own account outranks Instant"
      : ownToolkits.has(tk)
        ? "ok (own-credential output)"
        : "";
    console.log(`  ${tk.padEnd(14)} ${acc.status.padEnd(10)} ${acc.id}  ${tag}`);
    if (instantToolkits.has(tk) && acc.status === "ACTIVE")
      problems.push(`connected ${tk} account ${acc.id} for ${cfg.COMPOSIO_USER_ID} would take priority over Instant`);
  }
  for (const tk of ownToolkits) {
    if (!res.items.some((a) => a.toolkit.slug === tk && a.status === "ACTIVE"))
      console.log(`  ! no ACTIVE ${tk} connection yet (needed for outputs; run the OAuth step)`);
  }

  // Project-wide view: other user ids with connections on Instant toolkits.
  // Harmless for our user id, but explains surprises when testing under another id.
  // The SDK's camelCased list drops user_id, so use the raw client here.
  const all = await getComposio().getClient().connectedAccounts.list({ limit: 200 });
  const others = all.items.filter(
    (a) => instantToolkits.has(a.toolkit.slug) && a.user_id !== cfg.COMPOSIO_USER_ID,
  );
  if (others.length > 0) {
    console.log("\n  Other users in this project with own accounts on Instant toolkits (would bypass Instant for THEM):");
    for (const a of others) console.log(`    ${a.toolkit.slug.padEnd(14)} user=${a.user_id} ${a.status}`);
  }
}

async function checkTrigger() {
  try {
    const t = await getComposio().triggers.getType(TRIGGER_SLUG);
    console.log(`\n== Trigger ==\n  ${TRIGGER_SLUG}: found (${t.name})`);
  } catch (err) {
    console.log(`\n== Trigger ==\n  ${TRIGGER_SLUG}: lookup failed (${errorMessage(err)})`);
  }
}

async function main() {
  const problems: string[] = [];
  const planned = await checkPlannedTools(problems);
  const sweep = process.argv.includes("--sweep") ? await sweepToolkits() : undefined;
  await checkConnections(problems);
  await checkTrigger();

  mkdirSync("out", { recursive: true });
  writeFileSync(
    "out/discovery.json",
    JSON.stringify({ capturedAt: new Date().toISOString(), planned, sweep }, null, 2),
  );
  console.log("\nRaw responses written to out/discovery.json");

  if (problems.length > 0) {
    console.error(`\n✗ ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("\n✓ All planned Instant tools are eligible and have a reviewed price bound.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

export type { ToolSpec };
