import { describe, it, expect } from "vitest";
import { shouldWakeAgent, computeUsageTotal, sessionIdFromKey } from "./group-routing.js";

describe("shouldWakeAgent (@-routing, Plan 4b-2.2)", () => {
  it("wakes when there are no mentions (backward compat / single-agent)", () => {
    expect(shouldWakeAgent("part-1", { type: "dialogue.message" })).toBe(true);
    expect(shouldWakeAgent(undefined, { type: "dialogue.message" })).toBe(true);
  });

  it("wakes when mentioned (my participantId is in mentions)", () => {
    expect(shouldWakeAgent("part-1", { mentions: ["part-1"] })).toBe(true);
    expect(shouldWakeAgent("part-1", { mentions: ["part-2", "part-1"] })).toBe(true);
  });

  it("stays silent when someone else is mentioned", () => {
    expect(shouldWakeAgent("part-1", { mentions: ["part-2"] })).toBe(false);
  });

  it("stays silent when mentioned but my participantId is unknown (handshake not cached)", () => {
    expect(shouldWakeAgent(undefined, { mentions: ["part-2"] })).toBe(false);
  });

  it("ignores non-array mentions (treats as no mentions → wake)", () => {
    expect(shouldWakeAgent("part-1", { mentions: "part-1" })).toBe(true);
    expect(shouldWakeAgent("part-1", { mentions: null })).toBe(true);
  });
});

describe("computeUsageTotal (token usage, Plan 4b-2.3)", () => {
  it("prefers `total`", () => {
    expect(computeUsageTotal({ total: 42, promptTokens: 10, output: 5 })).toBe(42);
  });
  it("falls back to promptTokens + output when total missing", () => {
    expect(computeUsageTotal({ promptTokens: 30, output: 12 })).toBe(42);
  });
  it("falls back to input + output when promptTokens missing", () => {
    expect(computeUsageTotal({ input: 40, output: 2 })).toBe(42);
  });
  it("returns 0 for empty/missing usage", () => {
    expect(computeUsageTotal(null)).toBe(0);
    expect(computeUsageTotal(undefined)).toBe(0);
    expect(computeUsageTotal({})).toBe(0);
  });
});

describe("sessionIdFromKey", () => {
  it("strips the clawrent: prefix", () => {
    expect(sessionIdFromKey("clawrent:sess-123")).toBe("sess-123");
  });
  it("returns null for other channels / missing key", () => {
    expect(sessionIdFromKey("telegram:12345")).toBeNull();
    expect(sessionIdFromKey(undefined)).toBeNull();
    expect(sessionIdFromKey("noseparator")).toBeNull();
  });
});
