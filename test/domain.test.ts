import { describe, expect, it } from "vitest";
import { companyDomain, normalizeDomain } from "../src/domain.js";

describe("companyDomain", () => {
  it("uses the work email domain", () => {
    expect(companyDomain("Jane@Acme.io")).toEqual({ domain: "acme.io", source: "email" });
  });

  it("keeps subdomains of the email (e.g. regional mail hosts)", () => {
    expect(companyDomain("a@eu.acme.com").domain).toBe("eu.acme.com");
  });

  it("falls back to the submitted domain for free-mail addresses", () => {
    expect(companyDomain("jane@gmail.com", "https://www.Acme.com/pricing")).toEqual({ domain: "acme.com", source: "submitted" });
  });

  it("returns none when nothing usable is available", () => {
    expect(companyDomain("jane@gmail.com")).toEqual({ source: "none" });
    expect(companyDomain("jane@gmail.com", "outlook.com")).toEqual({ source: "none" });
  });

  it("normalizes URLs and ports", () => {
    expect(normalizeDomain("http://www.example.co.uk:8080/x?y")).toBe("example.co.uk");
    expect(normalizeDomain("not a domain")).toBeUndefined();
  });
});
