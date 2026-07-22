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
 * 模块级 provider 单例:同一进程内确保任何时刻只有一个 ProviderClient 连 /ws/agent。
 *
 * 背景:若 registerFull 被调用多次(OpenClaw 双加载 / startup 与 channel 双触发 /
 * health-monitor restart 叠加),而每次都 `void startProvider(...)`,会叠加多个
 * ProviderClient 用同一 agentToken 连 /ws/agent。后端 registerAgentClient 的语义是
 * 「新连接 4009 踢旧连接」,provider 侧 4009 走「非终态 → 无限重连」—— 两个实例互相
 * 踢、互相重连,形成稳态乒乓振荡(后端日志指纹:connected → ~350ms disconnected →
 * 2~3s connected 循环;provider 侧表现为 `presence reconnecting in 1000ms` 高频循环)。
 * 后果:presence 立不住 + reconnect 间隙漏接会话消息。
 *
 * 解法:用 chain 把所有 startProvider 串行化 —— 先干净停掉上一个实例(若有),再起新
 * 实例。无论 registerFull 被调几次,任何时刻只有一个 ProviderClient 占着 /ws/agent,
 * 4009 互踢消失。单实例下 provider 0.2.1+ 的自愈本就稳定(heartbeat 25s < 后端 40s 阈值,
 * 不会被 heartbeat 断)。注意:这只能防「同进程内」双实例;若用户在同 token 上同时跑
 * plugin 进程 + 另一个 provider(MCP start_serving / 第二个 OpenClaw 网关),仍会跨进程
 * 互踢 —— 那是部署规范(同一 agent 同时只能一个 provider serve)。
 */
let providerChain: Promise<void> = Promise.resolve();
let activeProvider: ProviderHandle | null = null;
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
      // token 优先取 openclaw 配置;缺失时回退读 ~/.clawrent/config.json,避免密钥写入 openclaw.json。
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
      if (!token) {
        ctx.logger?.warn?.("[clawrent] no token configured; channel inactive");
        return;
      }
      const apiBaseUrl: string | undefined = config.apiBaseUrl;
      const wsUrl: string | undefined = config.wsUrl;
      const agentId: string | undefined = config.agentId;
      const autoApprove: boolean = config.autoApproveSessions ?? true;
      const guardrailsFile: string | undefined = config.guardrailsFile;
      const accountId = agentId ?? "clawrent-provider";
      const cursorPath: string =
        config.cursorPath ??
        path.join(homedir(), ".clawrent", "openclaw-provider-cursor.json");

      const runtime = ctx.runtime;
      const cfg =
        typeof runtime?.config?.current === "function"
          ? runtime.config.current()
          : runtime?.cfg ?? {};

      // 串行化:先停上一个 provider 实例(幂等保护,防 registerFull 多次调用叠加多个
      // ProviderClient → 4009 乒乓),再起新实例。任何时刻只有一个 ProviderClient 连
      // /ws/agent(见模块级 providerChain 注释)。chain 排队也消除了「startProvider 异步
      // 启动期间第二次 registerClean 进入」的竞态(那时 activeProvider 尚未赋值)。
      const start = (): Promise<ProviderHandle | null> =>
        startProvider({
          agentToken: token,
          apiBaseUrl,
          wsUrl,
          cursorPath,
          agentId,
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
        }).catch((e) => {
          ctx.logger?.error?.(`[clawrent] startProvider failed: ${String(e)}`);
          return null;
        });

      providerChain = providerChain.then(async () => {
        if (activeProvider) {
          try { await activeProvider.stop(); } catch {}
          activeProvider = null;
        }
        activeProvider = await start();
      });

      // shutdown 只注册一次(多次 registerFull 不叠加 shutdown 回调);回调本身停当前
      // activeProvider 并入队 chain,保证停的是最终存活的那个实例。
      if (!shutdownRegistered) {
        shutdownRegistered = true;
        ctx.registerShutdown?.(() => {
          providerChain = providerChain.then(async () => {
            if (activeProvider) {
              try { await activeProvider.stop(); } catch {}
              activeProvider = null;
            }
          });
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
