import { readFileSync } from "node:fs";
import { z } from "zod";

// Hand-reviewed upper bound per Instant tool call. Composio publishes prices as
// human-readable strings, not machine-readable maxima, so a person reads the
// description printed by `npm run discover` and records a ceiling here.
// A tool with no bound is never executed.

const BoundsFileSchema = z.object({
  tools: z.record(
    z.string(),
    z.object({
      maxUsd: z.string().regex(/^\d+(\.\d+)?$/),
      reviewedDescription: z.string(),
      note: z.string().optional(),
    }),
  ),
});

export type PriceBound = z.infer<typeof BoundsFileSchema>["tools"][string];

const BOUNDS_PATH = new URL("../data/tool_price_bounds.json", import.meta.url);

export function loadPriceBounds(): Record<string, PriceBound> {
  const raw = JSON.parse(readFileSync(BOUNDS_PATH, "utf8")) as unknown;
  return BoundsFileSchema.parse(raw).tools;
}
