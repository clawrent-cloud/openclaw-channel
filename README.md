# clawrent-channel-plugin

OpenClaw **channel plugin** that turns ClawRent rental sessions into native
OpenClaw conversations, so a local PinkBo agent can answer rental requests
autonomously using its own model and identity.

目标：作为 **ClawRent 官方 contributor** 提交。本目录独立管理插件代码。

## 目录结构

```
clawrent-channel-plugin/
├─ openclaw.plugin.json   # 插件 manifest（严格 schema，OpenClaw 启动前校验）
├─ package.json           # openclaw 字段声明扩展入口
├─ tsconfig.json          # 用 OpenClaw 自带 typescript 编译
├─ src/
│  ├─ index.ts            # 入口：defineChannelPluginEntry + createChatChannelPlugin
│  ├─ clawrentClient.ts   # 包装 @clawrent/cli ApiClient（list/send/approve）
│  ├─ inbound.ts          # 轮询 ClawRent 活跃会话 → runtime.channel.inbound.run
│  ├─ outbound.ts         # ChannelOutboundAdapter.sendText → 写回 ClawRent
│  ├─ guardrails.ts       # 危险指令拦截（与 clawrent-guardrails.md 一致）
│  └─ setup/setup.ts      # 连接测试模块
└─ dist/                  # tsc 编译产物（git 忽略，开发期直接用 TS 源 link）
```

## 构建 / 校验

```powershell
# 用 OpenClaw 自带的 typescript 编译（无需全局安装）
$tsc = "C:\Users\PinkBagelGua\AppData\Roaming\npm\node_modules\openclaw\node_modules\typescript\bin\tsc"
node $tsc -p tsconfig.json
```

编译通过即说明 SDK 类型契约正确。

## 启用流程（待 Pink 确认后执行，会改动 openclaw.json + 重启 Gateway）

1. `openclaw plugins install --link <本目录>` 或手动在 `openclaw.json` 的
   `plugins.load.paths` 加入本目录。
2. `openclaw.json` 增加：
   ```json
   "plugins": {
     "entries": {
       "clawrent": {
         "enabled": true,
         "config": {
           "token": "agt_clawrent_xxx",
           "apiBaseUrl": "https://clawrent.cloud",
           "agentId": "019f35a8-...",
           "autoAnswer": true,
           "guardrailsFile": "D:/Agents/OpenClaw/PinkBo/clawrent-guardrails.md",
           "personaFiles": ["SOUL.md","USER.md","IDENTITY.md","AGENTS.md"]
         }
       }
     }
   }
   ```
3. 重启 Gateway。

## 已确认的 OpenClaw Channel Plugin SDK 事实（2026.6.11）

| 项 | 文档说法 | 实际实现（dist 验证） |
|----|----------|----------------------|
| 入口导出 | `defineChannelPluginEntry({ registerFull, registerCliMetadata })` | ✅ 正确，但**必须传 `plugin` 字段**（ChannelPlugin 实例），仅 registerFull 不够 |
| `createChatChannelPlugin` 参数 | 文档示例简洁 | 实际为 `{ base, outbound?, security?, pairing?, threading? }`；`base` 由 `createChannelPluginBase({ id, setup, config })` 构造；`id/name/kind/accountId` 不在顶层 |
| `ChannelOutboundAdapter.send` | 文档写 `send({ text })` | 实际是 `sendText(ctx)`，`ctx: ChannelOutboundContext`（从 `ctx.text` / `ctx.route` / `ctx.target` 取数据） |
| `defineChannelMessageAdapter` / `createMessageReceiptFromOutboundResults` | 文档放 `channel-core` | 实际在 `openclaw/plugin-sdk/channel-message` |
| `definePluginSetup` / `defineSetupSteps`（setup SDK） | 文档 `openclaw/plugin-sdk/setup` 有 | **不存在**；`setup` 模块只有底层 `ChannelSetupAdapter` 原语。已改用轻量 `testConnection()` 模块 |
| `defineSetupPluginEntry` | 未强调 | 存在于 `channel-core`，供独立 setup-entry 使用 |
| manifest `configSchema.required` | 示例多为可选 | 若把字段标 `required` 且 `plugins.entries.<id>.config` 未填，**整个 openclaw CLI 启动失败**（config validation 阻断全局）。应改为可选 + 运行时 warn |
| `plugins install --link` | 开发期 link | 会尝试改写 `openclaw.json` 增加 `plugins.entries.<id>`；若写入导致 size-drop 过大，OpenClaw 拒绝写入并生成 `.rejected` 备份（安全机制，主文件不破坏） |
| `install` 入口校验 | — | 报 `missing register/activate export` 与 `channelConfigs` 警告，即使使用 `defineChannelPluginEntry` 默认导出。install 校验与 defineChannelPluginEntry 约定存在偏差 |

## 待提交官方的问题清单（SDK / 文档偏差）

1. **`definePluginSetup` / `defineSetupSteps` 未实现**：`docs/plugins/sdk-entrypoints.md`
   描述了该 API，但 `openclaw/plugin-sdk/setup` 未导出。建议要么实现，要么更正文档。
2. **`createChatChannelPlugin` 文档与签名不符**：文档示例缺少 `base` 包装层，
   新手易写成 `{ id, name, kind, accountId, outbound }` 导致类型错误。建议文档给出
   `createChannelPluginBase` + `createChatChannelPlugin` 的完整最小示例。
3. **outbound `send` 签名文档化缺失**：`ChannelOutboundAdapter.sendText(ctx)`
   的 `ChannelOutboundContext` 结构未在文档示例中出现，只有简化的 `send({ text })`。
   建议补充真实 ctx 形状（如何取 route/sessionId）。
4. **manifest `required` 字段阻断全局 CLI**：channel plugin 的 config required 字段
   缺失会让 `openclaw` 任何子命令都因 config validation 失败而无法启动。建议：
   - 文档明确警告；或
   - OpenClaw 对"未启用插件"跳过 required 校验。
5. **`plugins install --link` 的入口校验与 `defineChannelPluginEntry` 不一致**：
   install 报 `missing register/activate export`，但 `defineChannelPluginEntry` 的
   返回值已含 `register`。建议统一 install 校验逻辑，或文档说明入口文件的导出约定。
6. **`channelConfigs` manifest 字段文档不足**：install 警告
   "channel plugin manifest declares clawrent without channelConfigs metadata"，
   但 manifest 已声明 `channelConfigs`。需明确该字段的精确期望结构。

## 设计要点

- **身份一致**：平台答案即本地 PinkBo（同 slug / token / persona 文件），
  成长通过 workspace 文件自然同步，无需手动触发。
- **护栏原生**：`guardrails.ts` 复用 `clawrent-guardrails.md` 的拦截清单，
  危险指令不驱动 agent，直接回复"需人工介入"。
- **轮询式 inbound**：ClawRent 无 webhook/WebSocket 原生推送时，用 `setTimeout`
  轮询 + `runtime.channel.inbound.run`，由 OpenClaw 跑 agent 并走 outbound 写回。
- **声明式 outbound**：用 `ChannelOutboundAdapter.sendText` 把回复写回会话，
  让 OpenClaw 负责队列/重试/receipt。
