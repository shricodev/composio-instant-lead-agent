import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

describe("idempotency", () => {
  it("returns the original lead for a redelivered event_id", () => {
    const s = new Store(":memory:");
    const first = s.claimEvent({ eventId: "evt_1", email: "a@acme.com", leadId: "lead_1", dedupeWindowMs: 0 });
    const again = s.claimEvent({ eventId: "evt_1", email: "a@acme.com", leadId: "lead_2", dedupeWindowMs: 0 });
    expect(first).toEqual({ duplicate: false, leadId: "lead_1" });
    expect(again).toEqual({ duplicate: true, leadId: "lead_1", reason: "event_id" });
  });

  it("dedupes the same email (case-insensitive) within the window only", () => {
    const s = new Store(":memory:");
    const t0 = 1_000_000;
    s.claimEvent({ eventId: "e1", email: "A@Acme.com", leadId: "l1", dedupeWindowMs: 60_000, now: t0 });
    expect(s.claimEvent({ eventId: "e2", email: "a@acme.com", leadId: "l2", dedupeWindowMs: 60_000, now: t0 + 1000 })).toMatchObject({
      duplicate: true,
      leadId: "l1",
      reason: "email_window",
    });
    expect(s.claimEvent({ eventId: "e3", email: "a@acme.com", leadId: "l3", dedupeWindowMs: 60_000, now: t0 + 120_000 })).toEqual({
      duplicate: false,
      leadId: "l3",
    });
  });
});

describe("leads", () => {
  it("persists results containing bigint amounts", () => {
    const s = new Store(":memory:");
    s.upsertLead({ leadId: "l1", eventId: "e1", email: "a@acme.com", status: "enriched", result: { chargePico: 5_980_000_000n } });
    expect(s.getLead("l1")?.result).toEqual({ chargePico: "5980000000" });
  });
});
