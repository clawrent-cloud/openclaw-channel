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
 * 背景:若同一 agent 的 startProvider 被并发调用多次(OpenClaw 双加载 / startup 与
 * channel 双触发 / health-monitor restart 叠加),每次都 `void startProvider(...)` 会
 * 叠加多个 ProviderClient 用同一 agentToken 连。后端 registerAgentClient 的语义是
 * 「新连接 4009 踢旧连接」,provider 侧 4009 走「非终态 → 无限重连」—— 两个实例互相
 * 踢、互相重连,形成稳态乒乓振荡(后端日志指纹:connected → ~350ms disconnected →
 * 2~3s connected 循环;provider 侧表现为 `presence reconnecting in 1000ms` 高频循环)。
 * 后果:presence 立不住 + reconnect 间隙漏接会话消息。
 *
 * 解法:按 agentId 分链(chain Map),每条链把该 agent 的 startProvider 串行化 ——
 * 先干净停掉该 agent 的上一个实例(若有),再起新实例。无论谁发起启动(startAccount
 * 或 legacy registerFull)、调几次,每个 agentId 任何时刻只有一个 ProviderClient 占着
 * 连接,4009 互踢消失。不同 agent 持不同 agentToken,彼此不会 4009 互踢(spec §6.4)。
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
  meta: {
    label: "ClawRent",
    selectionLabel: "ClawRent (rental sessions)",
    docsPath: "https://clawrent.cloud/docs/openclaw",
    blurb:
      "ClawRent rental sessions as native OpenClaw conversations, answered by your local provider agent.",
  },
  setup: setupAdapter as any,
  config: {
    listAccountIds: () => ["clawrent-provider"],
    resolveAccount: (_cfg: any, accountId?: string | null) => ({
      accountId: accountId ?? "clawrent-provider",
    }),
  } as any,
});

type AgentEntry = { agentId?: string; token: string };

/** Resolve the plugin config object from the gateway runtime cfg. */
function pluginConfigFromCfg(cfg: any): any {
  return cfg?.plugins?.entries?.[CHANNEL_ID]?.config ?? cfg?.plugins?.[CHANNEL_ID]?.config ?? {};
}

/** Read token from ~/.clawrent/config.json when not supplied inline. */
function readFallbackToken(log?: (m: string) => void): string | undefined {
  try {
    const crPath = path.join(homedir(), ".clawrent", "config.json");
    let raw = readFileSync(crPath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
    const cr = JSON.parse(raw);
    return (cr as any).token ?? (cr as any).agentToken;
  } catch (e) {
    log?.(`[clawrent] token fallback read failed: ${(e as any)?.message ?? e}`);
    return undefined;
  }
}

/**
 * Resolve the agents to serve from plugin config. Returns null when no usable
 * token is configured (channel should stay inactive).
 *  - multi:  config.agents:[{agentId,token}] → one ProviderClient per agent
 *  - single: config.token (+ optional config.agentId), ~/.clawrent/config.json fallback
 */
function resolveEntries(config: any, log?: (m: string) => void): AgentEntry[] | null {
  if (Array.isArray(config.agents) && config.agents.length > 0) {
    const entries = (config.agents as any[])
      .filter((a) => a && typeof a.token === "string" && a.token)
      .map((a) => ({
        agentId: typeof a.agentId === "string" ? a.agentId : undefined,
        token: a.token as string,
      }));
    if (entries.length === 0) {
      log?.("[clawrent] agents array configured but has no valid entries; channel inactive");
      return null;
    }
    return entries;
  }
  let token: string | undefined = config.token;
  if (!token) token = readFallbackToken(log);
  if (!token) {
    log?.("[clawrent] no token configured; channel inactive");
    return null;
  }
  return [{ agentId: config.agentId, token }];
}

interface ServeOptions {
  config: any; // plugin config
  cfg: any; // OpenClawConfig (from runtime)
  deps: {
    runChannelInboundEvent: (params: any) => Promise<any>;
    recordInboundSession: (params: any) => Promise<void>;
    dispatchReplyWithBufferedBlockDispatcher: (params: any) => Promise<any>;
  };
  onLog: (m: string) => void;
  /** Fired when a provider terminally dies (gateway-account lifecycle exits on it). */
  onTerminal?: (agentKey: string, reason: unknown) => void;
  /** Account abort signal — passed through to startProvider. */
  abortSignal?: AbortSignal;
}

/**
 * Start (or replace) one ProviderClient per resolved agent entry on its per-agentId
 * chain. The chain guarantees ≤1 ProviderClient per agent at any instant (4009 guard).
 * Handles are tracked in activeProviders.
 */
function serveAgents(opts: ServeOptions): void {
  const entries = resolveEntries(opts.config, opts.onLog);
  if (!entries) return;
  const multi = entries.length > 1;
  const apiBaseUrl: string | undefined = opts.config.apiBaseUrl;
  const wsUrl: string | undefined = opts.config.wsUrl;
  const autoApprove: boolean = opts.config.autoApproveSessions ?? true;
  const guardrailsFile: string | undefined = opts.config.guardrailsFile;
  const useGroupChannel: boolean = opts.config.useGroupChannel ?? true;
  const triagePrefilter: boolean | undefined = opts.config.triagePrefilter;
  const triageTwoPhase: boolean | undefined = opts.config.triageTwoPhase;
  const baseCursorPath: string =
    opts.config.cursorPath ?? path.join(homedir(), ".clawrent", "openclaw-provider-cursor.json");

  for (const entry of entries) {
    const agentKey = entry.agentId ?? "default";
    const cursorPath = multi ? `${baseCursorPath}.${agentKey}` : baseCursorPath;
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
        cfg: opts.cfg,
        deps: opts.deps,
        onLog: opts.onLog,
        onTerminal: opts.onTerminal,
        abortSignal: opts.abortSignal,
        useGroupChannel,
        triagePrefilter,
        triageTwoPhase,
      }).catch((e) => {
        opts.onLog(`[clawrent] startProvider failed (agent=${agentKey}): ${String(e)}`);
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
}

/**
 * Stop every active provider, each on its own chain so we stop the final live
 * instance. Returns a promise that resolves once all current chains settle.
 */
function stopAllAgents(): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const key of Array.from(providerChains.keys())) {
    const prev = providerChains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const h = activeProviders.get(key);
      if (h) {
        try { await h.stop(); } catch {}
        activeProviders.delete(key);
      }
    });
    providerChains.set(key, next);
    waits.push(next.catch(() => {}));
  }
  return Promise.all(waits).then(() => {});
}

const pluginDeps = {
  runChannelInboundEvent,
  recordInboundSession: recordInboundSession as any,
  dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcher as any,
};

/**
 * Gateway-account lifecycle adapter. When `channels.clawrent` is configured, the
 * gateway autostarts the account at boot and on every health-monitor restart by
 * calling startAccount; stopAccount is called on stop/restart. This is what makes
 * the provider recover after a terminal death WITHOUT disabling health-monitor.
 *
 * Why no setStatus: the gateway sets `running:true` while the startAccount task is
 * alive and `running:false` (setStoppedRuntime) when it exits. evaluateChannelHealth
 * keys off `running`, so simply keeping this task alive while the provider is up is
 * enough to be seen as healthy (no false-positive restart). When the provider
 * terminally dies (onTerminal), we exit; the gateway then auto-restarts us with a
 * bounded backoff (server-channels restartAttempts). We must NOT set
 * `terminalDisconnect` or the gateway would skip the restart.
 */
const gatewayAdapter = {
  async startAccount(ctx: any) {
    const config = pluginConfigFromCfg(ctx.cfg);
    const log = (m: string) => ctx.log?.info?.(m);
    const entries = resolveEntries(config, log);
    if (!entries) {
      ctx.log?.warn?.("[clawrent] startAccount: no token configured; staying stopped");
      return; // exit cleanly → gateway marks not-running (not an error)
    }
    if (ctx.abortSignal?.aborted) return;

    // Hold this task alive until a provider terminally dies or the account is
    // aborted. On exit (finally), stop everything; the gateway then restarts us.
    let release!: () => void;
    const exited = new Promise<void>((resolve) => { release = resolve; });
    let exitedOnce = false;
    const exitOnce = (reason: unknown) => {
      if (exitedOnce) return;
      exitedOnce = true;
      ctx.log?.error?.(`[clawrent] exiting account for restart: ${String(reason)}`);
      try { release(); } catch {}
    };
    if (ctx.abortSignal) {
      ctx.abortSignal.addEventListener("abort", () => exitOnce("account aborted"), { once: true });
    }

    serveAgents({
      config,
      cfg: ctx.cfg,
      deps: pluginDeps,
      onLog: log,
      onTerminal: (agentKey, reason) =>
        exitOnce(`provider terminally dead (agent=${agentKey}): ${String(reason)}`),
      abortSignal: ctx.abortSignal,
    });

    log("[clawrent] startAccount: provider(s) started; holding account alive");
    try {
      await exited;
    } finally {
      log("[clawrent] startAccount: stopping provider(s) before exit");
      await stopAllAgents();
    }
  },
  async stopAccount(_ctx: any) {
    // The gateway also aborts startAccount's abortSignal (which stops clients via
    // startProvider); this explicit stop is the idempotent belt-and-suspenders path
    // for flows that call stopAccount directly.
    await stopAllAgents();
  },
};

// Attach the gateway-account adapter. createChannelPluginBase/createChatChannelPlugin
// don't expose a `gateway` option today, but ChannelPlugin carries it and the runtime
// reads `plugin.gateway.startAccount/stopAccount`, so we attach it post-construction.
const chatPlugin = createChatChannelPlugin({ base: base as any });
const plugin = { ...chatPlugin, gateway: gatewayAdapter } as typeof chatPlugin & {
  gateway: typeof gatewayAdapter;
};

const entry: ReturnType<typeof defineChannelPluginEntry> = defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "ClawRent",
  description:
    "ClawRent rental-session channel: turns ClawRent rental sessions into native OpenClaw conversations so a local provider agent can answer tenants autonomously with its own model and identity. Uses @clawrent/provider for push-based inbound (no CLI daemon).",
  plugin: plugin as any,
  // 不在 entry 里注册 CLI command —— registerCliMetadata 阶段的 registerCommand
  // 要求 command.name 字段, 多余且易错; channel 插件无需自定义 command。
  registerFull(ctx: any) {
    try {
      const runtime = ctx.runtime;
      const cfg: any =
        typeof runtime?.config?.current === "function"
          ? runtime.config.current()
          : runtime?.cfg ?? {};

      // Adaptive start: when `channels.clawrent` is configured, the gateway owns the
      // account lifecycle (autostart + health-monitor restart via startAccount). Don't
      // start the provider here — startAccount will. Otherwise (no channels.clawrent)
      // fall back to starting from registerFull so the channel still works.
      if ((cfg as any)?.channels?.[CHANNEL_ID]) {
        ctx.logger?.info?.(
          "[clawrent] channels.clawrent configured — gateway owns account lifecycle; provider starts via startAccount",
        );
        return;
      }

      const config = ctx.config ?? pluginConfigFromCfg(cfg) ?? {};
      ctx.logger?.info?.("[clawrent] no channels.clawrent — starting provider from registerFull (legacy)");
      serveAgents({ config, cfg, deps: pluginDeps, onLog: (m) => ctx.logger?.info?.(m) });

      // shutdown 只注册一次(多次 registerFull 不叠加);停掉所有 active provider。
      if (!shutdownRegistered) {
        shutdownRegistered = true;
        ctx.registerShutdown?.(() => {
          void stopAllAgents();
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
