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

      let handle: ProviderHandle | null = null;

      void startProvider({
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
      })
        .then((h) => {
          handle = h;
        })
        .catch((e) => ctx.logger?.error?.(`[clawrent] startProvider failed: ${String(e)}`));

      ctx.registerShutdown?.(() => {
        if (handle) void handle.stop();
      });
    } catch (e) {
      ctx.logger?.error?.(`[clawrent] registerFull threw: ${(e as any)?.stack ?? e}`);
    }
  },
});

export default entry;

// Named export for install validation compatibility: OpenClaw's install-time validation
// checks for named `register`/`activate` exports, but `defineChannelPluginEntry` produces
// a default-export-only entry shape. Exporting `register` satisfies the validation without
// changing runtime behavior (the runtime uses the default export's register method).
// See docs/openclaw-sdk-notes.md #5.
export const register: (api: any) => void = entry.register;
