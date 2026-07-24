import {
  defineChannelPluginEntry,
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import { runChannelInboundEvent } from "openclaw/plugin-sdk/channel-inbound";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import path from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { startProvider, type ProviderHandle } from "./provider.js";
import { testConnection } from "./setup/setup.js";

const CHANNEL_ID = "clawrent";

/**
 * 模块级 provider 注册表:每个 agentId 一条串行化 chain + 一个 ProviderHandle,
 * 确保同一 agent 任何时刻只有一个 ProviderClient 连 /ws/agent(或 /ws/group)。
 *
 * 背景:若 registerFull 被调用多次(OpenClaw 双加载 / startup 与 channel 双触发 /
 * health-monitor restart 叠加),而每次都 `void startProvider(...)`,会叠加多个
 * ProviderClient 用同一 agentToken 连。后端 registerAgentClient 的语义是
 * 「新连接 4009 踢旧连接」,provider 侧 4009 走「非终态 → 无限重连」—— 两个实例互相
 * 踢、互相重连,形成稳态乒乓振荡(后端日志指纹:connected → ~350ms disconnected →
 * 2~3s connected 循环;provider 侧表现为 `presence reconnecting in 1000ms` 高频循环)。
 * 后果:presence 立不住 + reconnect 间隙漏接会话消息。
 *
 * 解法:按 agentId 分链(chain Map),每条链把该 agent 的 startProvider 串行化 ——
 * 先干净停掉该 agent 的上一个实例(若有),再起新实例。无论 registerFull 调几次,
 * 每个 agentId 任何时刻只有一个 ProviderClient 占着连接,4009 互踢消失。
 * 不同 agent 持不同 agentToken,彼此不会 4009 互踢(可安全共驻,spec §6.4)。
 * 单实例下 provider 0.3.0+ 的自愈稳定(heartbeat 25s < 后端 40s 阈值)。
 * 注意:这只能防「同进程内」同 agent 双实例;跨进程(同 token 跑 plugin + MCP
 * start_serving / 第二个网关)仍会互踢 —— 那是部署规范(同一 agent 同时只一个 provider serve)。
 */
const providerChains = new Map<string, Promise<void>>();
const activeProviders = new Map<string, ProviderHandle>();
let shutdownRegistered = false;

// Minimal setup adapter required by createChannelPluginBase.
const setupAdapter = {
  async testConnection(cfg: any) {
    return testConnection({ token: cfg?.token, apiBaseUrl: cfg?.apiBaseUrl });
  },
};

const base = createChannelPluginBase<{ accountId?: string | null }>({
  id: CHANNEL_ID,
  setup: setupAdapter as any,
  config: {
    listAccountIds: () => ["clawrent-provider"],
    resolveAccount: (_cfg: any, accountId?: string | null) => ({
      accountId: accountId ?? "clawrent-provider",
    }),
  } as any,
});

const plugin = createChatChannelPlugin({
  base: base as any,
});

const entry: ReturnType<typeof defineChannelPluginEntry> = defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "ClawRent",
  description:
    "ClawRent rental-session channel: turns ClawRent rental sessions into native OpenClaw conversations so a local provider agent can answer tenants autonomously with its own model and identity. Uses @clawrent/provider for push-based inbound (no CLI daemon).",
  plugin: plugin as any,
  // 注意: 不在 entry 里注册 CLI command —— registerCliMetadata 阶段的 registerCommand
  // 要求 command.name 字段, 多余且易错; channel 插件无需自定义 command。
  registerFull(ctx: any) {
    try {
      const config = ctx.config ?? {};
      // Plan 4b: /ws/group participant-scoped channel is the default. Set false to
      // fall back to legacy /ws/session (e.g. before the server auto-provisions the
      // provider-agent participant — Plan 4b Part A — else new sessions reject 4013).
      const useGroupChannel: boolean = config.useGroupChannel ?? true;

      // --- resolve the agents to serve (multi-agent array, else single token) ---
      // multi: config.agents:[{agentId,token}] → one ProviderClient per agent.
      // single: config.token (+ optional config.agentId), with ~/.clawrent/config.json
      // fallback so secrets need not live in openclaw.json.
      const resolveSingleToken = (): string | undefined => {
        let token: string | undefined = config.token;
        if (!token) {
          try {
            const crPath = path.join(homedir(), ".clawrent", "config.json");
            let raw = readFileSync(crPath, "utf8");
            if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
            const cr = JSON.parse(raw);
            token = (cr as any).token ?? (cr as any).agentToken;
          } catch (e) {
            ctx.logger?.warn?.(`[clawrent] token fallback read failed: ${(e as any)?.message ?? e}`);
          }
        }
        return token;
      };

      type AgentEntry = { agentId?: string; token: string };
      let entries: AgentEntry[];
      if (Array.isArray(config.agents) && config.agents.length > 0) {
        entries = (config.agents as any[])
          .filter((a) => a && typeof a.token === "string" && a.token)
          .map((a) => ({
            agentId: typeof a.agentId === "string" ? a.agentId : undefined,
            token: a.token as string,
          }));
        if (entries.length === 0) {
          ctx.logger?.warn?.("[clawrent] agents array configured but has no valid entries; channel inactive");
          return;
        }
      } else {
        const token = resolveSingleToken();
        if (!token) {
          ctx.logger?.warn?.("[clawrent] no token configured; channel inactive");
          return;
        }
        entries = [{ agentId: config.agentId, token }];
      }

      const apiBaseUrl: string | undefined = config.apiBaseUrl;
      const wsUrl: string | undefined = config.wsUrl;
      const autoApprove: boolean = config.autoApproveSessions ?? true;
      const guardrailsFile: string | undefined = config.guardrailsFile;
      const baseCursorPath: string =
        config.cursorPath ?? path.join(homedir(), ".clawrent", "openclaw-provider-cursor.json");

      const runtime = ctx.runtime;
      const cfg: any =
        typeof runtime?.config?.current === "function"
          ? runtime.config.current()
          : runtime?.cfg ?? {};

      // (Re)start one ProviderClient per agent, each on its OWN per-agentId chain so the
      // same agent never has two concurrent clients (4009 protection; see module doc).
      // Different agents use different tokens and never 4009 each other (spec §6.4).
      for (const entry of entries) {
        const agentKey = entry.agentId ?? "default";
        // per-agent cursor file when serving multiple agents (independent dedupe state)
        const cursorPath = entries.length > 1 ? `${baseCursorPath}.${agentKey}` : baseCursorPath;
        const accountId = entry.agentId ?? "clawrent-provider";

        const start = (): Promise<ProviderHandle | null> =>
          startProvider({
            agentToken: entry.token,
            apiBaseUrl,
            wsUrl,
            cursorPath,
            agentId: entry.agentId,
            autoApprove,
            guardrailsFile,
            channelId: CHANNEL_ID,
            accountId,
            cfg,
            deps: {
              runChannelInboundEvent,
              recordInboundSession: recordInboundSession as any,
              dispatchReplyWithBufferedBlockDispatcher:
                dispatchReplyWithBufferedBlockDispatcher as any,
            },
            onLog: (m) => ctx.logger?.info?.(`[clawrent] ${m}`),
            useGroupChannel,
          }).catch((e) => {
            ctx.logger?.error?.(`[clawrent] startProvider failed (agent=${agentKey}): ${String(e)}`);
            return null;
          });

        const prevChain = providerChains.get(agentKey) ?? Promise.resolve();
        providerChains.set(
          agentKey,
          prevChain.then(async () => {
            const prev = activeProviders.get(agentKey);
            if (prev) {
              try { await prev.stop(); } catch {}
              activeProviders.delete(agentKey);
            }
            const handle = await start();
            if (handle) activeProviders.set(agentKey, handle);
          }),
        );
      }

      // shutdown 只注册一次(多次 registerFull 不叠加);停掉所有 active provider,每个走自己的 chain,
      // 保证停的是最终存活的实例。
      if (!shutdownRegistered) {
        shutdownRegistered = true;
        ctx.registerShutdown?.(() => {
          for (const key of Array.from(providerChains.keys())) {
            const prev = providerChains.get(key) ?? Promise.resolve();
            providerChains.set(
              key,
              prev.then(async () => {
                const h = activeProviders.get(key);
                if (h) {
                  try { await h.stop(); } catch {}
                  activeProviders.delete(key);
                }
              }),
            );
          }
        });
      }
    } catch (e) {
      ctx.logger?.error?.(`[clawrent] registerFull threw: ${(e as any)?.stack ?? e}`);
    }
  },
});

export default entry;

// Named exports for install-time validation compatibility.
// OpenClaw's validation historically checks for named `register`/`activate` exports
// (see docs/openclaw-sdk-notes.md #5). `defineChannelPluginEntry` produces a
// default-export-only entry whose `register` method lives on the entry object.
// Re-exporting `register` (and `activate` as a fallback alias) satisfies the
// validation without changing runtime behavior: the runtime calls the default
// export's register method, which dispatches to registerFull in `full` mode.
export const register: (api: any) => void = entry.register;
export const activate: (api: any) => void = entry.register;
