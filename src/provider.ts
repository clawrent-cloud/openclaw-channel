// provider.ts — 用 @clawrent/provider 的 ProviderClient 驱动无人值守 provider。
//
// 数据流(已由 probe-inbound.mjs 实测钉死 kernel 契约):
//
//   ClawRent WS 推送 → ProviderClient.onMessage(session, message)
//     → 解析 message(取 payload.content / type)
//     → 护栏判定(危险指令直接拦截,不驱动 agent)
//     → runChannelInboundEvent({ channel:"clawrent", raw, adapter })
//          adapter.ingest      → NormalizedTurnInput
//          adapter.resolveTurn → { ...base, ctxPayload, recordInboundSession, runDispatch }
//            runDispatch → dispatchReplyWithBufferedBlockDispatcher(跑 agent)
//              → dispatcherOptions.deliver(payload)  // payload.text = 模型答案
//                → providerClient.send(sessionId, { type, payload:{content} })  // 回发 ClawRent
//
// 依赖来源(已钉死):
//   - recordInboundSession                    ← openclaw/plugin-sdk/conversation-runtime
//   - dispatchReplyWithBufferedBlockDispatcher ← openclaw/plugin-sdk/reply-dispatch-runtime
//   - runChannelInboundEvent                   ← openclaw/plugin-sdk/channel-inbound

import { checkGuardrails, loadGuardrails, prefilter, phase1Triage } from "./guardrails.js";
import { isAddressedToMe, computeUsageTotal, sessionIdFromKey } from "./group-routing.js";
import { onDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";

export interface ProviderRuntimeDeps {
  runChannelInboundEvent: (params: any) => Promise<any>;
  recordInboundSession: (params: any) => Promise<void>;
  dispatchReplyWithBufferedBlockDispatcher: (params: any) => Promise<any>;
}

export interface StartProviderOptions {
  agentToken: string;
  apiBaseUrl?: string;
  wsUrl?: string;
  cursorPath: string;
  agentId?: string;
  autoApprove: boolean;
  guardrailsFile?: string; // 外置护栏策略文件(追加在内置规则之后)
  channelId: string;
  accountId: string;
  cfg: any; // OpenClawConfig(从 runtime 取)
  deps: ProviderRuntimeDeps;
  onLog?: (msg: string) => void;
  /** Plan 4b: opt into /ws/group (participant-scoped) instead of /ws/session. */
  useGroupChannel: boolean;
  /** D3: triage switches. prefilter default on; twoPhase default off. */
  triagePrefilter?: boolean;
  triageTwoPhase?: boolean;
  /**
   * Fired once when this provider terminally dies (ProviderClient emits
   * `agent:dead` / `agent:activation:failed`). The gateway-account lifecycle
   * (index.ts startAccount) uses this to exit the account task so the gateway
   * auto-restarts it (bounded backoff). Optional — absent in legacy mode.
   */
  onTerminal?: (agentKey: string, reason: unknown) => void;
  /**
   * Account abort signal. When aborted (gateway stopping the account), stop the
   * ProviderClient. Removed again in the returned handle's stop() for cleanliness.
   */
  abortSignal?: AbortSignal;
}

export interface ProviderHandle {
  stop: () => Promise<void> | void;
}

const CHANNEL = "clawrent";

/**
 * 从原始 ClawRent WS 帧提取对话文本。仅 dialogue.* 类型进入 agent;
 * 其余(instruction.* / result.* / task_update 等)按护栏与业务规则处理。
 */
function extractDialogue(message: Record<string, unknown>): { type: string; content: string } {
  const type = String((message as any)?.type ?? (message as any)?.messageType ?? "");
  const content =
    (message as any)?.payload?.content ??
    (message as any)?.content ??
    "";
  return { type, content: String(content ?? "") };
}

/**
 * D2 上下文 → OpenClaw ChannelStructuredContext entries（2026.9 channel contract）。
 * 旧字段名 UntrustedStructuredContext 的移除窗口 2026-09-08 已过；9.3 运行时只认
 * entries 数组形状。7.1 宿主不认识新字段 → 退化为 BodyForAgent preamble 通道，
 * 与 9.3 修复前状态一致（两个宿主时代行为对齐，见 plan Task 6 差异表）。
 */
export interface ClawRentSessionContext {
  addressedToMe: boolean;
  sender: {
    participantId?: string;
    side?: string;
    agentId?: string;
    consumerUserId?: string;
  };
  mentions: unknown[];
  gist?: string;
  participantId?: string;
}

export function buildStructuredContextEntries(untrusted: ClawRentSessionContext) {
  return [
    {
      label: "ClawRent session context",
      source: "clawrent",
      type: "clawrent-session-context",
      payload: untrusted,
    },
  ];
}

/** 2026.9 canonical route key; peer = ClawRent sessionId. */
export function buildRouteSessionKey(sessionId: string, agentId = "main"): string {
  return `agent:${agentId}:${CHANNEL}:direct:${sessionId.toLowerCase()}`;
}

export async function startProvider(opts: StartProviderOptions): Promise<ProviderHandle> {
  const log = (m: string) => (opts.onLog ? opts.onLog(m) : console.log(`[clawrent:provider] ${m}`));

  // 动态 import,避免插件在未安装 @clawrent/provider 时整体加载失败。
  let ProviderClient: any;
  let FileCursorStore: any;
  try {
    const mod: any = await import("@clawrent/provider");
    ProviderClient = mod.ProviderClient;
    FileCursorStore = mod.FileCursorStore;
  } catch (e) {
    log(`@clawrent/provider not available: ${String(e)}; provider inactive`);
    return { stop: () => {} };
  }

  const client = new ProviderClient({
    agentToken: opts.agentToken,
    ...(opts.apiBaseUrl ? { apiUrl: opts.apiBaseUrl } : {}),
    ...(opts.wsUrl ? { wsUrl: opts.wsUrl } : {}),
    cursorStore: new FileCursorStore(opts.cursorPath),
    autoApprove: opts.autoApprove,
    useGroupChannel: opts.useGroupChannel,
  });

  // Surface presence self-heal events (SDK EventEmitter). These replace the dead
  // onDisconnect/onError args previously passed to client.start() — ProviderCallbacks
  // never had those fields, so they were silently ignored.
  const agentKey = opts.agentId ?? "default";
  // Terminal death is fire-once: notifies the account lifecycle (onTerminal) so the
  // gateway can auto-restart the account. Guarded so multiple terminal events don't
  // re-fire.
  let terminated = false;
  const fireTerminal = (reason: unknown) => {
    if (terminated) return;
    terminated = true;
    opts.onTerminal?.(agentKey, reason);
  };
  client.on('agent:reconnecting', (delay: number) => log(`presence reconnecting in ${delay}ms`));
  client.on('agent:activated', () => log(`presence activated (online)`));
  client.on('agent:activation:failed', (_aid: unknown, err: unknown) => {
    log(`presence activation FAILED (terminal): ${(err as Error)?.message ?? err}`);
    fireTerminal(err);
  });
  client.on('agent:dead', (_aid: unknown, reason: unknown) => {
    log(`presence DEAD — terminal close, will not reconnect: ${reason}`);
    fireTerminal(reason);
  });
  // Stop the client when the gateway aborts the account (stopChannel/restart).
  const onAbort = () => {
    try { client.stop(); } catch { /* best-effort */ }
  };
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) onAbort();
    else opts.abortSignal.addEventListener("abort", onAbort, { once: true });
  }
  // Phase 3: pause/resume observability (ProviderClient 0.4.0 emits these).
  // Pause = consumer paused this agent (4020 close, no reconnect); resume = consumer
  // resumed → ProviderClient reconnects /ws/group. The agent simply goes idle while
  // paused (no inbound messages arrive) — no extra plugin-side gating needed.
  client.on('session:paused', (sid: string, reason: unknown) =>
    log(`session PAUSED sid=${sid} (consumer paused this agent; will not reconnect until resumed): ${reason}`),
  );
  client.on('session:resumed', (sid: string) =>
    log(`session RESUMED sid=${sid} — reconnecting /ws/group`),
  );

  // Plan 4b-2.3: capture per-session model token usage from OpenClaw diagnostics so
  // outbound replies can carry payload.usage.totalTokens for per_token metering.
  // Best-effort — if OpenClaw doesn't tag model.usage with a clawrent sessionKey the
  // cache stays empty and totalTokens is omitted (backend skips → backward compatible).
  const usageBySession = new Map<string, number>();
  const unsubDiagnostic = onDiagnosticEvent((evt) => {
    if (evt.type !== 'model.usage') return;
    const sid =
      sessionIdFromKey(evt.sessionKey) ??
      (evt.channel === CHANNEL ? evt.sessionId : undefined);
    if (typeof sid !== 'string') return;
    const total = computeUsageTotal(evt.usage);
    if (total > 0) usageBySession.set(sid, total);
  });

  // client.start() resolves once the ProviderClient is set up. If initial setup
  // throws (e.g. 401 auth, unreachable API), treat it as terminal so the account
  // lifecycle (startAccount) exits and the gateway runs its bounded auto-restart
  // (retries transient failures; gives up on persistent config errors). Without
  // this, a setup failure would leave startAccount holding the task alive with no
  // live provider and no recovery.
  const startError: unknown = await client.start({
    agentId: opts.agentId,

    onPendingApproval: async (session: any) => {
      // 平台基线为 false(不自动批准);批准动作只在此端侧一道门发生。
      // 护栏最高优先级:危险类永远转人工,无视 autoApprove 开关。
      const task = String(session?.taskDescription ?? session?.task ?? "");
      const fileContent = loadGuardrails(opts.guardrailsFile);
      const res = checkGuardrails(task, fileContent);
      if (res.blocked) {
        log(`[clawrent] blocked pending session=${session?.sessionId}: ${res.reason}`);
        return false; // 危险 → 转人工
      }
      // 非危险:跟随端侧代理开关(默认 true = 按护栏自动接单;false = 全转人工)。
      log(`pending approval (non-dangerous) session=${session?.sessionId} autoApprove=${opts.autoApprove}`);
      return opts.autoApprove;
    },

    onSessionNew: (session: any) => {
      log(`session new: ${session?.sessionId}`);
    },

    onSessionEnded: (session: any, reason?: string) => {
      log(`session ended: ${session?.sessionId} reason=${reason ?? ""}`);
    },

    onMessage: async (session: any, message: Record<string, unknown>) => {
      const sessionId: string = session?.sessionId;
      const rawType: string = String((message as any)?.type ?? (message as any)?.messageType ?? "?");
      log(`onMessage RAW session=${sessionId} type=${rawType}`);
      const { type, content } = extractDialogue(message);
      log(`onMessage session=${sessionId} type=${type} len=${content.length}`);

      // 只处理对话类;其它类型不驱动 agent。
      if (!type.startsWith("dialogue")) {
        log(`skip non-dialogue message type=${type} session=${sessionId}`);
        return;
      }
      if (!content.trim()) {
        log(`skip empty content session=${sessionId}`);
        return;
      }

      // D1: @-gate removed — agent self-decides whether to reply (prompt-based).
      // @ is now CONTEXT (addressedToMe), threaded to the agent via ChannelStructuredContext (D2).
      const addressedToMe = isAddressedToMe(session?.participantId, message);

      // D2 prefilter (D3: gated by triagePrefilter, default on) — silent-drop garbage.
      if (opts.triagePrefilter !== false) {
        const pre = prefilter(content);
        if (pre.drop) {
          log(`prefilter drop session=${sessionId}: ${pre.reason}`);
          return;
        }
      }
      // D3 phase-1 (default off via triageTwoPhase) — cheap pre-screen before full dispatch.
      if (opts.triageTwoPhase) {
        const p1 = phase1Triage(content);
        if (p1.skip) {
          log(`phase-1 skip session=${sessionId}: ${p1.reason}`);
          return;
        }
      }

      // 护栏:危险指令直接拦截,不驱动 agent。
      const guard = checkGuardrails(content);
      if (guard.blocked) {
        log(`guardrail blocked session=${sessionId}: ${guard.reason}`);
        await client
          .send(sessionId, {
            type: "dialogue.message",
            payload: { content: `⚠️ ${guard.reason}` },
          })
          .catch((e: unknown) => log(`send block notice failed: ${String(e)}`));
        return;
      }

      // 驱动 OpenClaw agent 跑一个 inbound turn。
      // OpenClaw 2026.9 canonical route session key (agent:<agent>:<channel>:direct:<peer>).
      // 7.1 treats session keys as opaque strings (no validation), so this is safe on the
      // >=2026.7.1 floor; 9.3 REFUSES non-canonical writes (SessionCanonicalKeyMigrationRequiredError).
      // Peer id = ClawRent sessionId (UUID, lowercased to satisfy key normalization).
      const routeSessionKey = buildRouteSessionKey(sessionId);
      const consumerId = session?.consumerUserId ?? "consumer";

      // D2: ChannelStructuredContext — sender / mentions / gist / @-addressing. With the
      // @-gate gone (D1), this is what lets the agent self-decide whether + how to reply.
      const mentions = Array.isArray((message as any).mentions) ? (message as any).mentions : [];
      const untrusted = {
        addressedToMe,
        sender: {
          participantId: (message as any).sender?.participantId,
          side: (message as any).sender?.side,
          agentId: (message as any).sender?.agentId,
          consumerUserId: session?.consumerUserId,
        },
        mentions,
        gist: session?.taskDescription,
        participantId: session?.participantId,
      };
      // Inject the context as a preamble in the agent-facing text so the model literally
      // sees it (also available structured on ctxPayload.ChannelStructuredContext).
      const textForAgentContent =
        `[被@: ${addressedToMe ? "是" : "否"}] ` +
        `[发送方: ${untrusted.sender.side ?? "unknown"}] ` +
        `[会话: ${untrusted.gist ?? ""}] ` +
        `[mentions: ${mentions.length}]\n${content}`;

      const ctxPayload: Record<string, unknown> = {
        From: `${CHANNEL}:${consumerId}`,
        Body: content,
        RawBody: content,
        BodyForAgent: textForAgentContent,
        channel: CHANNEL,
        SessionKey: routeSessionKey,
        ChannelStructuredContext: buildStructuredContextEntries(untrusted),
      };

      const raw = { sessionId, consumerId, content, message, textForAgent: textForAgentContent };

      try {
        await opts.deps.runChannelInboundEvent({
          channel: CHANNEL,
          accountId: opts.accountId,
          raw,
          log: (ev: any) => {
            if (ev?.event === "error") {
              log(`turn ${ev.stage} error: ${ev?.error?.message ?? ev?.error}`);
            }
          },
          adapter: {
            ingest: (r: any) => ({
              id: `${r.sessionId}:${(r.message as any)?.id ?? Date.now()}`,
              timestamp: Date.now(),
              rawText: r.content,
              textForAgent: (r as any).textForAgent ?? r.content,
              textForCommands: r.content,
              raw: r,
            }),
            resolveTurn: () => ({
              channel: CHANNEL,
              accountId: opts.accountId,
              routeSessionKey,
              // storePath omitted: 9.3 canonical session store owns route entries; a custom path was resolved against the gateway CWD (System32) on 9.x.
              ctxPayload,
              recordInboundSession: opts.deps.recordInboundSession,
              record: { createIfMissing: true, updateLastRoute: true },
              runDispatch: async () => {
                // 通知 consumer:provider 正在生成回复(dialogue.typing 控制信号,后端短路
                // 转发、不持久化/不计 metering)。WS-only:sendTyping 在 WS 非 OPEN 时静默
                // 返回 false,不影响下方 client.send 的 WS+REST fallback 主路。
                client.sendTyping(sessionId);
                // 长生成期间持续心跳;SDK 内置 500ms/session 防抖,800ms 间隔保证每次真发。
                const typingTimer = setInterval(() => client.sendTyping(sessionId), 800);
                try {
                  return await opts.deps.dispatchReplyWithBufferedBlockDispatcher({
                    ctx: ctxPayload,
                    cfg: opts.cfg,
                    dispatcherOptions: {
                      deliver: async (payload: any) => {
                        const replyText: string =
                          payload?.text ?? payload?.content ?? "";
                        if (!replyText.trim()) return;
                        // Plan 4b-2.3: attach captured per_token usage (if any) so the
                        // backend accumulates participant.totalTokens for this reply.
                        const capturedUsage = usageBySession.get(sessionId);
                        await client.send(sessionId, {
                          type: "dialogue.message",
                          payload: {
                            content: replyText,
                            ...(capturedUsage ? { usage: { totalTokens: capturedUsage } } : {}),
                          },
                        });
                        log(`replied session=${sessionId} (${replyText.length} chars${capturedUsage ? `, ${capturedUsage} tokens` : ""})`);
                      },
                      // 模型跑失败时,把错误回发给租户(不静默),便于人工发现。
                      onError: async (err: any) => {
                        const msg = err?.message ?? String(err);
                        log(`dispatch error session=${sessionId}: ${msg}`);
                        await client
                          .send(sessionId, {
                            type: "dialogue.message",
                            payload: { content: `⚠️ provider 生成回复时出错,需人工介入:${msg}` },
                          })
                          .catch((e: unknown) => log(`send error notice failed: ${String(e)}`));
                      },
                    },
                  });
                } finally {
                  clearInterval(typingTimer);
                }
              },
            }),
          },
        });
        log(`runChannelInboundEvent done session=${sessionId}`);
      } catch (e) {
        log(`runChannelInboundEvent failed session=${sessionId}: ${String(e)}`);
      }
    },
  }).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (startError !== undefined) {
    log(`provider failed to start (terminal): ${String(startError)}`);
    fireTerminal(startError);
    return {
      stop: () => {
        if (opts.abortSignal) opts.abortSignal.removeEventListener("abort", onAbort);
        // client.start() threw before setup completed (e.g. 401 auth, unreachable
        // API). Do NOT call client.stop() here — the SDK has an internal pending
        // firstActivation promise that stop() would reject with "Provider stopped",
        // and that rejection is unhandled and crashes the host gateway. The client
        // never finished starting, so there is nothing to stop.
      },
    };
  }

  log(`provider started (agentId=${opts.agentId ?? "auto"} autoApprove=${opts.autoApprove})`);

  return {
    stop: () => {
      try {
        unsubDiagnostic();
      } catch {
        /* diagnostic unsubscribe best-effort */
      }
      if (opts.abortSignal) opts.abortSignal.removeEventListener("abort", onAbort);
      try {
        client.stop();
      } catch (e) {
        log(`stop error: ${String(e)}`);
      }
    },
  };
}
