// Free SDK smoke checks: verifies session APIs behave the way the pipeline
// assumes. Creates sessions and reads metadata only; executes no paid tool.
//
//   npm run verify-sdk

import { createSession, directTools, getComposio, restoreSession } from "../composio.js";
import { TIER2_TOOLS } from "../tools.js";

function show(label: string, value: unknown) {
  console.log(`\n--- ${label} ---`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function main() {
  const composio = getComposio();

  // 1. Create + restore (session-per-lead-run strategy relies on this).
  const s1 = await createSession("tier1");
  show("tier1 sessionId", s1.sessionId);
  show("tier1 config.instant (as returned)", (s1.config as Record<string, unknown>).instant);
  show("tier1 warnings", s1.warnings);

  const restored = await restoreSession(s1.sessionId);
  show("restore via sessions.use", { sameId: restored.sessionId === s1.sessionId });

  // 2. Tier-2 model tools: direct schemas for exactly the research slugs.
  const research = await directTools(TIER2_TOOLS.map((t) => t.slug));
  show("tier2 direct tool names", research.map((t) => ("name" in t ? t.name : "?")));

  // 3. Kill switch + the "any instant object re-enables" gotcha, on a throwaway session.
  const throwaway = await createSession("tier1");
  const off = await throwaway.update({ instant: false });
  show("after update({ instant: false })", (off as Record<string, unknown>).instant);
  const reenabled = await throwaway.update({ instant: { returnInstantCharge: true } });
  show("after update({ instant: { returnInstantCharge: true } }) — re-enabled?", (reenabled as Record<string, unknown>).instant);
  const omitted = await throwaway.update({});
  show("after update({}) — policy preserved?", (omitted as Record<string, unknown>).instant);
  await throwaway.delete().catch((e: unknown) => show("delete throwaway failed", String(e)));

  // 4. Project-wide Instant spend so far (free endpoint).
  const usage = await composio.experimental.usage.summary({});
  show("usage summary (last 30 days) instantCharge", usage.instantCharge);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
