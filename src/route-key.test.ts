import { describe, expect, it } from "vitest";
import { buildRouteSessionKey } from "./provider.js";

describe("buildRouteSessionKey (OpenClaw 2026.9 canonical session key grammar)", () => {
  it("builds agent:main:clawrent:direct:<uuid> from a lowercase session id", () => {
    const sessionId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(buildRouteSessionKey(sessionId)).toBe(
      `agent:main:clawrent:direct:${sessionId}`,
    );
  });

  it("lowercases a mixed-case session id to satisfy key normalization", () => {
    expect(buildRouteSessionKey("AbC-123-XYZ")).toBe(
      "agent:main:clawrent:direct:abc-123-xyz",
    );
  });

  it("places a custom agentId in the head segment", () => {
    expect(buildRouteSessionKey("sess-1", "ops")).toBe(
      "agent:ops:clawrent:direct:sess-1",
    );
  });
});
