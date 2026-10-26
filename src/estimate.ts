import { loadConfig } from "./config.js";
import { picoToUsd, usdToPico, type Pico } from "./money.js";
import { loadPriceBounds } from "./priceBounds.js";
import type { Store } from "./store.js";
import { TIER1_TOOLS } from "./tools.js";

// Pre-run cost estimates from the reviewed price bounds (published prices are
// ceilings; real charges have come in lower because of provider discounts).

export type Estimate = { typicalUsd: string; worstUsd: string; worstPico: Pico };

export function estimateLeads(count: number, opts: { tier2: boolean }): Estimate {
  const cfg = loadConfig();
  const bounds = loadPriceBounds();
  const bound = (slug: string) => usdToPico(bounds[slug]?.maxUsd ?? "0");
  const tier1All = TIER1_TOOLS.reduce((s, t) => s + bound(t.slug), 0n);
  const tier1Typical = tier1All - bound("APOLLO_PEOPLE_ENRICHMENT");
  // Worst case per lead is capped by the tier budget, whichever is lower.
  const tier1Worst = minPico(tier1All, usdToPico(cfg.TIER1_BUDGET_USD));
  const tier2Worst = opts.tier2 ? usdToPico(cfg.TIER2_BUDGET_USD) : 0n;
  const n = BigInt(count);
  return {
    typicalUsd: picoToUsd(tier1Typical * n),
    worstUsd: picoToUsd((tier1Worst + tier2Worst) * n),
    worstPico: (tier1Worst + tier2Worst) * n,
  };
}

/** Everything the ledger currently counts against the global cap. */
export function committedUsd(store: Store): string {
  const total = store.reservations().reduce((s, r) => {
    if (r.status === "settled") return s + (r.actualPico ?? 0n);
    if (r.status === "released") return s;
    return s + r.reservedPico;
  }, 0n);
  return picoToUsd(total);
}

function minPico(a: Pico, b: Pico): Pico {
  return a < b ? a : b;
}
