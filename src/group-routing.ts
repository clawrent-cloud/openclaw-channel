// group-routing.ts — Plan 4b pure helpers for /ws/group participant-scoped mode.
//
// Kept dependency-free + side-effect-free so the @-routing and token-usage logic
// can be unit-tested without standing up an OpenClaw runtime or a live WS server.

/** @-routing policy (spec §6.3 + Plan 4b-2.2).
 *
 * Decides whether THIS provider agent should wake (drive the OpenClaw bot) for an
 * inbound group message:
 *  - No `mentions` → wake. Backward-compatible with the single-agent /ws/session
 *    plugin (where every consumer message is answered). Also the sensible default
 *    when a session has a single provider agent.
 *  - `mentions` present → wake ONLY if this agent's participantId is in the list.
 *    Non-@-ed agents stay silent (spec §6.3). If our participantId is unknown
 *    (handshake not yet cached), we cannot match → sleep (safer than guessing).
 *
 * Note: in legacy /ws/session mode there is no top-level `mentions` and
 * `myParticipantId` is undefined → always wakes (unchanged behavior). */
export function shouldWakeAgent(
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

/** Map a clawrent routeSessionKey (`<channel>:<sessionId>`) back to the sessionId.
 *  Returns null if the key is missing or not for this channel. */
export function sessionIdFromKey(
  sessionKey: string | undefined,
  channel = "clawrent",
): string | null {
  if (typeof sessionKey !== "string") return null;
  const prefix = `${channel}:`;
  return sessionKey.startsWith(prefix) ? sessionKey.slice(prefix.length) : null;
}
