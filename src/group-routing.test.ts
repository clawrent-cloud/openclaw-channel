import { describe, it, expect } from "vitest";
import { isAddressedToMe, computeUsageTotal, sessionIdFromKey } from "./group-routing.js";

describe("isAddressedToMe (D1: @ context, was @-gate)", () => {
  it("true when there are no mentions (backward compat / single-agent)", () => {
    expect(isAddressedToMe("part-1", { type: "dialogue.message" })).toBe(true);
    expect(isAddressedToMe(undefined, { type: "dialogue.message" })).toBe(true);
  });

  it("true when mentioned (my participantId is in mentions)", () => {
    expect(isAddressedToMe("part-1", { mentions: ["part-1"] })).toBe(true);
    expect(isAddressedToMe("part-1", { mentions: ["part-2", "part-1"] })).toBe(true);
  });

  it("false when someone else is mentioned", () => {
    expect(isAddressedToMe("part-1", { mentions: ["part-2"] })).toBe(false);
  });

  it("false when mentioned but my participantId is unknown (handshake not cached)", () => {
    expect(isAddressedToMe(undefined, { mentions: ["part-2"] })).toBe(false);
  });

  it("ignores non-array mentions (treats as no mentions → true)", () => {
    expect(isAddressedToMe("part-1", { mentions: "part-1" })).toBe(true);
    expect(isAddressedToMe("part-1", { mentions: null })).toBe(true);
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

describe("sessionIdFromKey (canonical route keys, OpenClaw 2026.9+)", () => {
  it("maps a canonical 5-segment key to its peer (peer = ClawRent sessionId)", () => {
    expect(sessionIdFromKey("agent:agt-1:clawrent:direct:sess-9")).toBe("sess-9");
  });

  it("maps a canonical key regardless of agentId", () => {
    expect(sessionIdFromKey("agent:other-agent-77:clawrent:direct:sess-9")).toBe("sess-9");
  });

  it("maps the 6-segment per-account shape (dmScope per account)", () => {
    expect(sessionIdFromKey("agent:agt-1:clawrent:acct-42:direct:sess-9")).toBe("sess-9");
  });

  it("still maps the legacy clawrent:<sid> shape", () => {
    expect(sessionIdFromKey("clawrent:sess-legacy")).toBe("sess-legacy");
  });

  it("returns null for canonical keys of a different channel", () => {
    expect(sessionIdFromKey("agent:x:other:direct:y")).toBeNull();
    expect(sessionIdFromKey("other:z")).toBeNull();
    // channel name in the accountId slot only — still another channel's key.
    expect(sessionIdFromKey("agent:x:other:clawrent:direct:y")).toBeNull();
  });

  it("returns null for undefined / garbage / truncated keys", () => {
    expect(sessionIdFromKey(undefined)).toBeNull();
    expect(sessionIdFromKey("agent:x:clawrent:direct")).toBeNull();
    expect(sessionIdFromKey("agent:x:clawrent:direct:")).toBeNull();
    expect(sessionIdFromKey("direct:sess-9")).toBeNull();
  });
});
