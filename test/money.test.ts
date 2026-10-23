import { describe, expect, it } from "vitest";
import { picoToUsd, usdToPico } from "../src/money.js";

describe("money", () => {
  it("parses 12-decimal charges exactly", () => {
    expect(usdToPico("0.012")).toBe(12_000_000_000n);
    expect(usdToPico("0.000000000001")).toBe(1n);
    expect(usdToPico("1")).toBe(1_000_000_000_000n);
  });

  it("sums without float drift", () => {
    const total = ["0.1", "0.2"].map(usdToPico).reduce((a, b) => a + b, 0n);
    expect(picoToUsd(total)).toBe("0.30");
  });

  it("rejects malformed amounts and excess precision", () => {
    expect(() => usdToPico("1e-3")).toThrow();
    expect(() => usdToPico("-1")).toThrow();
    expect(() => usdToPico("0.0000000000001")).toThrow();
  });
});
