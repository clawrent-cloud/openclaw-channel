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

import { checkGuardrails, loadGuardrails } from "./guardrails.js";

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
  });

  await client.start({
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

    onDisconnect: (info?: any) => {
      log(`disconnected: ${info?.reason ?? JSON.stringify(info)}`);
    },

    onError: (err?: any) => {
      log(`provider error: ${err?.message ?? JSON.stringify(err)}`);
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
      const routeSessionKey = `${CHANNEL}:${sessionId}`;
      // Windows 文件名不允许冒号, storePath 需做安全转义。
      const storePath = routeSessionKey.replace(/[:]/g, "_");
      const consumerId = session?.consumerUserId ?? "consumer";

      const ctxPayload: Record<string, unknown> = {
        From: `${CHANNEL}:${consumerId}`,
        Body: content,
        RawBody: content,
        BodyForAgent: content,
        channel: CHANNEL,
        SessionKey: routeSessionKey,
      };

      const raw = { sessionId, consumerId, content, message };

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
              textForAgent: r.content,
              textForCommands: r.content,
              raw: r,
            }),
            resolveTurn: () => ({
              channel: CHANNEL,
              accountId: opts.accountId,
              routeSessionKey,
              storePath,
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
                        await client.send(sessionId, {
                          type: "dialogue.message",
                          payload: { content: replyText },
                        });
                        log(`replied session=${sessionId} (${replyText.length} chars)`);
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
  });

  log(`provider started (agentId=${opts.agentId ?? "auto"} autoApprove=${opts.autoApprove})`);

  return {
    stop: () => {
      try {
        client.stop();
      } catch (e) {
        log(`stop error: ${String(e)}`);
      }
    },
  };
}
