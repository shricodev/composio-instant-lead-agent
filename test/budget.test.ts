import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, BudgetedExecutor, InstantDisabledError, WalletExhaustedError, type ToolExecutor } from "../src/budget.js";
import { usdToPico } from "../src/money.js";
import { Store } from "../src/store.js";

const bounds = {
  CHEAP: { maxUsd: "0.01", reviewedDescription: "" },
  PRICEY: { maxUsd: "0.18", reviewedDescription: "" },
};

function ok(amount?: string): Awaited<ReturnType<ToolExecutor["execute"]>> {
  return {
    data: {},
    error: null,
    logId: "log_1",
    resultType: "completed",
    ...(amount ? { instantCharge: { amount, currency: "USD", charged_by: "composio" } } : {}),
  };
}

function make(store: Store, executor: ToolExecutor, over: Partial<ConstructorParameters<typeof BudgetedExecutor>[0]> = {}) {
  return new BudgetedExecutor({
    store,
    executor,
    bounds,
    leadId: "lead_1",
    runKey: "lead_1:tier1",
    sessionId: "trs_1",
    runBudgetUsd: "0.30",
    globalCapUsd: "1.50",
    instantEnabled: () => true,
    ...over,
  });
}

describe("BudgetedExecutor", () => {
  it("passes the explicit Instant account only when configured", async () => {
    const execute = vi.fn(async () => ok("0.001"));
    await make(new Store(":memory:"), { execute }, { explicitAccount: true }).execute("CHEAP", {});
    await make(new Store(":memory:"), { execute }).execute("CHEAP", {});
    expect(execute).toHaveBeenNthCalledWith(1, "CHEAP", {}, { account: "instant_account" });
    expect(execute).toHaveBeenNthCalledWith(2, "CHEAP", {}, {});
  });

  it("settles the reported charge", async () => {
    const store = new Store(":memory:");
    const execute = vi.fn(async () => ok("0.004000000001"));
    const ex = make(store, { execute });
    await ex.execute("CHEAP", { q: 1 });
    expect(store.spentFor("lead_1:tier1")).toBe(usdToPico("0.004000000001"));
    expect(ex.calls[0]).toMatchObject({ status: "settled", credentialSource: "instant_account" });
  });

  it("refuses a call whose bound would exceed the run budget", async () => {
    const store = new Store(":memory:");
    const execute = vi.fn(async () => ok("0.18"));
    const ex = make(store, { execute }, { runBudgetUsd: "0.30" });
    await ex.execute("PRICEY", {});
    await expect(ex.execute("PRICEY", {})).rejects.toMatchObject({ reason: "run_budget" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses tools without a reviewed bound", async () => {
    const ex = make(new Store(":memory:"), { execute: vi.fn() });
    await expect(ex.execute("UNKNOWN", {})).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("concurrent calls cannot double-spend: in-flight reservations count", async () => {
    const store = new Store(":memory:");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const execute = vi.fn(async () => (await gate, ok("0.18")));
    const ex = make(store, { execute }, { runBudgetUsd: "0.30" });
    const first = ex.execute("PRICEY", {});
    const second = ex.execute("PRICEY", {});
    await expect(second).rejects.toMatchObject({ reason: "run_budget" });
    release();
    await first;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("enforces the global cap across runs", async () => {
    const store = new Store(":memory:");
    const execute = vi.fn(async () => ok("0.18"));
    await make(store, { execute }, { runKey: "a", globalCapUsd: "0.20" }).execute("PRICEY", {});
    await expect(make(store, { execute }, { runKey: "b", globalCapUsd: "0.20" }).execute("PRICEY", {})).rejects.toMatchObject({
      reason: "global_cap",
    });
  });

  it("402 releases the reservation and raises WalletExhaustedError", async () => {
    const store = new Store(":memory:");
    const err = Object.assign(new Error("402"), { status: 402, details: { slug: "Metering_WalletBalanceExhausted" } });
    const ex = make(store, { execute: vi.fn(async () => Promise.reject(err)) });
    await expect(ex.execute("CHEAP", {})).rejects.toBeInstanceOf(WalletExhaustedError);
    expect(store.reservations()[0]).toMatchObject({ status: "released" });
  });

  it("a 4xx rejection releases the reservation (the tool never ran)", async () => {
    const store = new Store(":memory:");
    const err = Object.assign(new Error("400 account not supported"), { status: 400 });
    const ex = make(store, { execute: vi.fn(async () => Promise.reject(err)) });
    await expect(ex.execute("CHEAP", {})).rejects.toThrow("400");
    expect(store.reservations()[0]).toMatchObject({ status: "released", actualPico: 0n });
  });

  it("a timeout leaves an unresolved reservation that still counts against the budget", async () => {
    const store = new Store(":memory:");
    const ex = make(store, { execute: vi.fn(async () => Promise.reject(new Error("ETIMEDOUT"))) }, { runBudgetUsd: "0.20" });
    await expect(ex.execute("PRICEY", {})).rejects.toThrow("ETIMEDOUT");
    expect(store.reservations()[0]).toMatchObject({ status: "unresolved", reservedPico: usdToPico("0.18") });
    await expect(ex.execute("PRICEY", {})).rejects.toMatchObject({ reason: "run_budget" });
  });

  it("no charge in the response: asks the execution log before settling", async () => {
    const store = new Store(":memory:");
    const logLookup = vi.fn(async () => ({ instantCharge: "0.003", credentialSource: "instant_account" }));
    const ex = make(store, { execute: vi.fn(async () => ok()) }, { logLookup });
    await ex.execute("CHEAP", {});
    expect(logLookup).toHaveBeenCalledWith("log_1");
    expect(store.spentFor("lead_1:tier1")).toBe(usdToPico("0.003"));
  });

  it("completed with no charge anywhere stays unresolved (absent charge is not proof of free)", async () => {
    const store = new Store(":memory:");
    const ex = make(store, { execute: vi.fn(async () => ok()) }, { logLookup: async () => ({ credentialSource: "instant_account" }) });
    await ex.execute("CHEAP", {});
    expect(store.reservations()[0]).toMatchObject({ status: "unresolved" });
  });

  it("kill switch: no reservation, no call", async () => {
    const store = new Store(":memory:");
    const execute = vi.fn();
    const ex = make(store, { execute }, { instantEnabled: () => false });
    await expect(ex.execute("CHEAP", {})).rejects.toBeInstanceOf(InstantDisabledError);
    expect(execute).not.toHaveBeenCalled();
    expect(store.reservations()).toHaveLength(0);
  });
});
