# OpenClaw Channel Plugin SDK 踩坑笔记

> **来源**:PinkBo 在 2026.6.11 前后基于 `openclaw@2026.6.11` 实测整理,随 plugin 移交。
> 这些是**第一手踩坑记录**(文档说法 vs dist 实际实现),开发/升级 openclaw 时必读。
> 由 ClawRent 官方接管后持续维护——openclaw 升级后请复核每条是否仍成立,过时的标注并更新。

---

## 1. 已确认的 OpenClaw Channel Plugin SDK 事实（2026.6.11）

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
| install 入口校验 | — | 报 `missing register/activate export` 与 `channelConfigs` 警告，即使使用 `defineChannelPluginEntry` 默认导出。install 校验与 defineChannelPluginEntry 约定存在偏差 |

---

## 2. 待提交官方的问题清单（SDK / 文档偏差）

> 这些是文档与实现不符、值得回馈给 OpenClaw 官方的点。若已回馈/修复，请标注。

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
   （PinkBo 已通过给 `channelConfigs.clawrent` 补 `schema` 修复了加载告警。）

---

*整理：PinkBo（2026-6.11 实测）· 接管维护：ClawRent 官方*
