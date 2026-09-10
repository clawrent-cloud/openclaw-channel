import { describe, expect, it } from "vitest";
import { buildStructuredContextEntries } from "./provider.js";

describe("buildStructuredContextEntries (OpenClaw 2026.9 channel contract)", () => {
  it("wraps the D2 context as a ChannelStructuredContextEntry array", () => {
    const untrusted = {
      addressedToMe: true,
      sender: { participantId: "p1", side: "consumer", agentId: undefined, consumerUserId: "u1" },
      mentions: [{}, {}],
      gist: "租房咨询",
      participantId: "p-me",
    };
    const entries = buildStructuredContextEntries(untrusted);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      label: "ClawRent session context",
      source: "clawrent",
      type: "clawrent-session-context",
    });
    expect((entries[0] as { payload: unknown }).payload).toBe(untrusted);
  });
});
