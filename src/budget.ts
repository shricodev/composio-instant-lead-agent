import { INSTANT_ACCOUNT } from "./composio.js";
import { picoToUsd, usdToPico, type Pico } from "./money.js";
import type { PriceBound } from "./priceBounds.js";
import type { Store } from "./store.js";

// Every Instant call goes through BudgetedExecutor:
//   reserve a trusted upper bound -> execute on the Instant account -> record the
//   actual charge -> reconcile. Composio has no spend cap of its own (the wallet
//   balance is checked asynchronously), so this is the only real limit.

/** The slice of a Composio session we need; lets tests inject a fake. */
export type ToolExecutor = {
  execute(
    slug: string,
    args: Record<string, unknown>,
    options: { account?: string },
  ): Promise<{ data: Record<string, unknown>; error: string | null; logId: string; resultType: string; instantCharge?: unknown }>;
};

/** Looks up an execution log; used when the response carries no charge. */
export type LogLookup = (logId: string) => Promise<{ instantCharge?: string; credentialSource?: string } | undefined>;

export class BudgetExceededError extends Error {
  constructor(
    readonly toolSlug: string,
    readonly reason: "run_budget" | "global_cap" | "no_bound",
    detail: string,
  ) {
    super(`Budget refused ${toolSlug}: ${reason} (${detail})`);
    this.name = "BudgetExceededError";
  }
}

/** HTTP 402 Metering_WalletBalanceExhausted: the SDK throws a plain APIError with status 402. */
export class WalletExhaustedError extends Error {
  constructor(readonly toolSlug: string, cause: unknown) {
    super(`Composio wallet exhausted while calling ${toolSlug}`, { cause });
    this.name = "WalletExhaustedError";
  }
}

export class InstantDisabledError extends Error {
  constructor(readonly toolSlug: string) {
    super(`Instant is disabled (kill switch); skipped ${toolSlug}`);
    this.name = "InstantDisabledError";
  }
}

/** A 4xx (other than 408 timeout) means the request was refused before the tool ran. */
export function isRejectedBeforeExecution(err: unknown): boolean {
  const status = err && typeof err === "object" ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}

export function isWalletExhausted(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; details?: { slug?: string }; error?: { error?: { slug?: string } } };
  return e.status === 402 || e.details?.slug === "Metering_WalletBalanceExhausted" || e.error?.error?.slug === "Metering_WalletBalanceExhausted";
}

/** instantCharge arrives untyped and snake_case: { amount: "0.012", currency: "USD", charged_by }. */
export function parseInstantCharge(charge: unknown): Pico | undefined {
  if (!charge || typeof charge !== "object") return undefined;
  const { amount, currency } = charge as { amount?: unknown; currency?: unknown };
  if (typeof amount !== "string") return undefined;
  if (currency !== undefined && currency !== "USD") throw new Error(`Unexpected Instant charge currency: ${String(currency)}`);
  return usdToPico(amount);
}

export type CallRecord = {
  toolSlug: string;
  reservationId: number;
  status: "settled" | "released" | "unresolved";
  chargePico: Pico | null;
  credentialSource: string | null;
  logId: string | null;
  note?: string;
};

export type BudgetedExecutorOptions = {
  store: Store;
  executor: ToolExecutor;
  logLookup?: LogLookup;
  bounds: Record<string, PriceBound>;
  leadId: string;
  /** Budget scope: one per lead per tier, e.g. `${leadId}:tier1`. */
  runKey: string;
  sessionId: string | null;
  runBudgetUsd: string;
  globalCapUsd: string;
  instantEnabled: () => boolean;
  /** Pass account: "instant_account" explicitly (needs a multi-account session). */
  explicitAccount?: boolean;
};

export class BudgetedExecutor {
  readonly calls: CallRecord[] = [];
  private readonly runBudget: Pico;
  private readonly globalCap: Pico;

  constructor(private readonly opts: BudgetedExecutorOptions) {
    this.runBudget = usdToPico(opts.runBudgetUsd);
    this.globalCap = usdToPico(opts.globalCapUsd);
  }

  /** Settled Instant spend for this run, in USD. */
  get spentUsd(): string {
    return picoToUsd(this.opts.store.spentFor(this.opts.runKey));
  }

  async execute(slug: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown>; error: string | null; logId: string; resultType: string }> {
    const { store } = this.opts;
    if (!this.opts.instantEnabled()) throw new InstantDisabledError(slug);

    const bound = this.opts.bounds[slug];
    if (!bound) throw new BudgetExceededError(slug, "no_bound", "no reviewed upper bound in data/tool_price_bounds.json");
    const amount = usdToPico(bound.maxUsd);

    const res = store.reserve({
      leadId: this.opts.leadId,
      runKey: this.opts.runKey,
      sessionId: this.opts.sessionId,
      toolSlug: slug,
      amount,
      runBudget: this.runBudget,
      globalCap: this.globalCap,
    });
    if (!res.ok) {
      const limit = res.reason === "run_budget" ? this.runBudget : this.globalCap;
      const used = res.reason === "run_budget" ? res.committedRun : res.committedGlobal;
      throw new BudgetExceededError(slug, res.reason, `committed $${picoToUsd(used)} + bound $${bound.maxUsd} > limit $${picoToUsd(limit)}`);
    }

    let result: Awaited<ReturnType<ToolExecutor["execute"]>>;
    try {
      // Either force the Instant account explicitly, or rely on routing priority
      // (guarded by assertInstantRouting); reconcile() checks the credential source.
      result = await this.opts.executor.execute(slug, args, this.opts.explicitAccount ? { account: INSTANT_ACCOUNT } : {});
    } catch (err) {
      if (isWalletExhausted(err)) {
        // The wallet refused the call before running it: nothing was charged.
        store.resolveReservation(res.id, { status: "released", actual: 0n, note: "402 wallet exhausted" });
        this.record({ toolSlug: slug, reservationId: res.id, status: "released", chargePico: 0n, credentialSource: null, logId: null, note: "402" });
        throw new WalletExhaustedError(slug, err);
      }
      if (isRejectedBeforeExecution(err)) {
        store.resolveReservation(res.id, { status: "released", actual: 0n, note: `rejected: ${String(err).slice(0, 200)}` });
        this.record({ toolSlug: slug, reservationId: res.id, status: "released", chargePico: 0n, credentialSource: null, logId: null, note: "4xx" });
        throw err;
      }
      // Timeout / network error: the provider may still have done billable work.
      // Keep the reservation (it still counts against the budget) and never auto-retry;
      // reportCosts reconciles it from the execution logs.
      store.resolveReservation(res.id, { status: "unresolved", note: `threw: ${String(err).slice(0, 200)}` });
      this.record({ toolSlug: slug, reservationId: res.id, status: "unresolved", chargePico: null, credentialSource: null, logId: null });
      throw err;
    }

    await this.reconcile(res.id, slug, amount, result);
    return result;
  }

  private async reconcile(id: number, slug: string, bound: Pico, result: Awaited<ReturnType<ToolExecutor["execute"]>>) {
    const { store } = this.opts;
    let charge = parseInstantCharge(result.instantCharge);
    let credentialSource: string | null = charge !== undefined ? "instant_account" : null;
    let note: string | undefined;

    if (charge === undefined && this.opts.logLookup) {
      // No charge in the response. That is NOT proof the call was free: ask the log.
      const log = await this.opts.logLookup(result.logId).catch(() => undefined);
      if (log?.instantCharge !== undefined) charge = usdToPico(log.instantCharge);
      credentialSource = log?.credentialSource ?? credentialSource;
    }

    if (charge !== undefined) {
      if (charge > bound) note = `charge $${picoToUsd(charge)} exceeded bound $${picoToUsd(bound)}`;
      store.resolveReservation(id, { status: "settled", actual: charge, logId: result.logId, credentialSource, note: note ?? null });
      this.record({ toolSlug: slug, reservationId: id, status: "settled", chargePico: charge, credentialSource, logId: result.logId, ...(note ? { note } : {}) });
      if (note) console.warn(`[budget] ${slug}: ${note}`);
      return;
    }

    if (result.resultType !== "completed" || (credentialSource !== null && credentialSource !== "instant_account")) {
      // Failed calls aren't charged; own-account calls never are.
      store.resolveReservation(id, { status: "released", actual: 0n, logId: result.logId, credentialSource, note: result.resultType });
      this.record({ toolSlug: slug, reservationId: id, status: "released", chargePico: 0n, credentialSource, logId: result.logId });
      return;
    }

    // Completed on Instant (or unknown source) with no charge visible yet: keep the
    // reservation open as unresolved so it still counts until the logs confirm it.
    store.resolveReservation(id, { status: "unresolved", logId: result.logId, credentialSource, note: "completed without visible charge" });
    this.record({ toolSlug: slug, reservationId: id, status: "unresolved", chargePico: null, credentialSource, logId: result.logId });
  }

  private record(c: CallRecord) {
    this.calls.push(c);
  }
}
