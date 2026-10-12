// group-routing.ts — Plan 4b pure helpers for /ws/group participant-scoped mode.
//
// Kept dependency-free + side-effect-free so the @-routing and token-usage logic
// can be unit-tested without standing up an OpenClaw runtime or a live WS server.

/** Is this provider agent @-addressed by the inbound group message? (D1: was a
 *  wake/sleep GATE — now CONTEXT only; the agent self-decides whether to reply.)
 *
 * Returns true (addressed / no @ in play) when:
 *  - No `mentions` → true (backward-compat single-agent /ws/session; sensible
 *    default when a session has a single provider agent).
 *  - `mentions` present + this agent's participantId is in the list → true.
 * Returns false only when `mentions` names others and our participantId is known
 * but absent (or participantId unknown → conservatively false).
 *
 * Note: in legacy /ws/session mode there is no top-level `mentions` and
 * `myParticipantId` is undefined → true (unchanged). */
export function isAddressedToMe(
  myParticipantId: string | undefined,
  message: Record<string, unknown>,
): boolean {
  const raw = message["mentions"];
  const mentions = Array.isArray(raw) ? (raw as unknown[]) : [];
  if (mentions.length === 0) return true;
  if (typeof myParticipantId !== "string") return false;
  return mentions.includes(myParticipantId);
}

/** Reduce a `model.usage` diagnostic `usage` object to a single token total.
 *  Preference: `total` → `promptTokens + output` → `input + output`. 0 if none. */
export function computeUsageTotal(
  usage:
    | {
        total?: number;
        promptTokens?: number;
        input?: number;
        output?: number;
      }
    | undefined
    | null,
): number {
  if (!usage) return 0;
  if (typeof usage.total === "number") return usage.total;
  const output = typeof usage.output === "number" ? usage.output : 0;
  // Discriminate on whether promptTokens is present (not on output>0, which would
  // wrongly short-circuit the input+output fallback when only output is reported).
  if (typeof usage.promptTokens === "number") return usage.promptTokens + output;
  const input = typeof usage.input === "number" ? usage.input : 0;
  return input + output;
}

/** Map a route session key back to the ClawRent sessionId. Two accepted shapes:
 *  - Legacy route key: `<channel>:<sessionId>` (pre-2026.9).
 *  - Canonical OpenClaw route key (2026.9+): `agent:<agentId>:<channel>:direct:<peerId>`
 *    or `agent:<agentId>:<channel>:<accountId>:direct:<peerId>` (per-account dmScope) —
 *    the trailing peer segment is the ClawRent sessionId.
 *  Returns null if the key is missing, malformed, or not for this channel. */
export function sessionIdFromKey(
  sessionKey: string | undefined,
  channel = "clawrent",
): string | null {
  if (typeof sessionKey !== "string") return null;
  // Legacy route key: `<channel>:<sessionId>`.
  const prefix = `${channel}:`;
  if (sessionKey.startsWith(prefix)) return sessionKey.slice(prefix.length);
  // Canonical OpenClaw route key (2026.9+): `agent:<agentId>:<channel>:direct:<peerId>`
  // or `agent:<agentId>:<channel>:<accountId>:direct:<peerId>` — channel is always the
  // 3rd segment (index 2); the trailing peer is the ClawRent sessionId.
  const segs = sessionKey.split(":");
  if (
    segs.length >= 5 &&
    segs[0] === "agent" &&
    segs[2] === channel &&
    segs[segs.length - 2] === "direct"
  ) {
    return segs[segs.length - 1] || null;
  }
  return null;
}
