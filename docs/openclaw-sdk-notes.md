# OpenClaw Channel Plugin SDK 踩坑笔记

> **来源**:PinkBo 在 2026.6.11 前后基于 `openclaw@2026.6.11` 实测整理,随 plugin 移交;2026-09-10 于 2026.9.3 复核(见差异表)。
> 这些是**第一手踩坑记录**(文档说法 vs dist 实际实现),开发/升级 openclaw 时必读。
> 由 ClawRent 官方接管后持续维护——openclaw 升级后请复核每条是否仍成立,过时的标注并更新。

---

## 0. 7.1 vs 9.3 已知差异表（0.8.0 维护的地板=2026.7.1，2026-09-10 审计）

| 面 | 2026.7.1 | 2026.9.3 | 我们的策略 |
|---|---|---|---|
| 结构化上下文字段 | `UntrustedStructuredContext`，resolver 同样只收 entries 数组（对象形状在任何宿主上都从未生效） | `ChannelStructuredContext`（entries 数组），旧名已过移除窗口 | 只写新字段；0.8.0 是结构化上下文首次真正生效的版本（9.3），7.1 宿主仍走 BodyForAgent preamble |
| capability consent | 无 | install/enable/升级需 `--accept-capabilities`（第三方插件，能力面变化触发） | README 引导；manifest 面保持最小 |
| `plugins.installs` 落盘 | plugin 管理命令可能写入（legacy 残留） | 写盘自动剥除；strict schema 拒绝该 key | 宿主侧问题，见 memory `openclaw-8-2-installs-key-fix` |
| channel meta | 不要求 | label/selectionLabel/docsPath/blurb 缺失时 gateway 兜底并告警 | 0.8.0 显式提供 |
| Node 运行时 | 无硬性要求 | 宿主要求 Node ≥24.16（宿主侧约束，非插件约束） | 文档提示，不在 engines 强制 |
| update rehearsal | 无 | 宿主升级排练会核对插件兼容声明+channel readiness | 声明准确（Task 2），readiness 快速返回 |
| `configSchema.required` 非空 | 整个 CLI 启动失败（全局阻断） | **定向报错**：`config validate` 报 `plugins.entries.<id>.config.<field>: must have required property` 后 exit 1；`plugins list` 不受影响（2026-09-10 实测） | 仍保持空数组（兼容 8.x 前宿主），见 issue #4 |
| 缺 `channels.clawrent` 块 | channel 不触发加载（行为缺失） | 插件**仍加载**：legacy `registerFull` 兜底与 gateway `startAccount` **双路径同时各启动一个 provider**（实测 2 条 `provider started` + 2 条 `presence activated`） | 必须配块——只走 gateway 托管单实例路径（README 两块契约） |
| `uninstall` 是否删 `channels.<id>` 块 | 未验证 | **仍删除**（源码 `uninstall-config` → `removePluginRuntimePolicyFromConfig` 删 `channels.<channelIds>` + `plugins.entries.<id>` + allow 项；未实测活卸载——生产机禁 `uninstall --force`） | 保留 README uninstall 警告 |
| install record 缓存 manifest | 改磁盘 + `registry --refresh` 不够，必须新版本包 | **按 plugin 记 `manifestHash`，漂移即失效**并回退 derived(live) index（实测改 manifest 即报 `registry no longer matches`） | 结论不变（onStartup 保持 false），理由更新（README onStartup 段） |
| `channels status --deep` | 存在，7.1 有显示 bug | **flag 已移除**（`OpenClaw does not recognize option "--deep"`；deep 变体迁至 `openclaw status --deep` / `gateway status --deep`）；普通 `channels status` 实测显示准确 | 按 9.3 口径更新 README 警告 |
| setup SDK 面 | `openclaw/plugin-sdk/setup` 仅底层原语 | 仍无 `definePluginSetup`/`defineSetupSteps`，但 setup 子路径导出大幅扩充（`setup`/`channel-setup`/`setup-runtime`/`setup-tools`/`provider-setup`，含 `defineChannelSetupContract`、`createClackPrompter` 等） | 继续用 `testConnection()` 轻量 setup（issue #1） |

---

## 1. 已确认的 OpenClaw Channel Plugin SDK 事实（2026.6.11）

> **2026-09-10 于 2026.9.3 复核**：逐条对照 9.3 dist 重验——入口导出（`defineChannelPluginEntry` 带 `plugin` 字段，agent-harness-runtime d.ts:22731）、`createChatChannelPlugin`/`createChannelPluginBase` 包装层、outbound `sendText(ctx)`（outbound.types d.ts:368）、`defineChannelMessageAdapter` 在 `plugin-sdk/channel-message`、`defineSetupPluginEntry` 在 `channel-core`、`--link` 写盘拒绝时 `.rejected.<timestamp>` 备份（io.write）——**均未变**。有更新的是下面两行（行内标注）。

| 项 | 文档说法 | 实际实现（dist 验证） |
|----|----------|----------------------|
| 入口导出 | `defineChannelPluginEntry({ registerFull, registerCliMetadata })` | ✅ 正确，但**必须传 `plugin` 字段**（ChannelPlugin 实例），仅 registerFull 不够 |
| `createChatChannelPlugin` 参数 | 文档示例简洁 | 实际为 `{ base, outbound?, security?, pairing?, threading? }`；`base` 由 `createChannelPluginBase({ id, setup, config })` 构造；`id/name/kind/accountId` 不在顶层 |
| `ChannelOutboundAdapter.send` | 文档写 `send({ text })` | 实际是 `sendText(ctx)`，`ctx: ChannelOutboundContext`（从 `ctx.text` / `ctx.route` / `ctx.target` 取数据） |
| `defineChannelMessageAdapter` / `createMessageReceiptFromOutboundResults` | 文档放 `channel-core` | 实际在 `openclaw/plugin-sdk/channel-message` |
| `definePluginSetup` / `defineSetupSteps`（setup SDK） | 文档 `openclaw/plugin-sdk/setup` 有 | **不存在**；`setup` 模块只有底层 `ChannelSetupAdapter` 原语。已改用轻量 `testConnection()` 模块。（2026-09-10 于 9.3 复核：仍不存在——全 dist 无此二符号；但 setup 子路径导出已大幅扩充，见 §0 差异表末行） |
| `defineSetupPluginEntry` | 未强调 | 存在于 `channel-core`，供独立 setup-entry 使用 |
| manifest `configSchema.required` | 示例多为可选 | 若把字段标 `required` 且 `plugins.entries.<id>.config` 未填，**整个 openclaw CLI 启动失败**（config validation 阻断全局）。应改为可选 + 运行时 warn（2026-09-10 于 9.3 复核：已收敛为定向报错，见 §0 差异表 + issue #4） |
| `plugins install --link` | 开发期 link | 会尝试改写 `openclaw.json` 增加 `plugins.entries.<id>`；若写入导致 size-drop 过大，OpenClaw 拒绝写入并生成 `.rejected` 备份（安全机制，主文件不破坏） |
| install 入口校验 | — | 报 `missing register/activate export` 与 `channelConfigs` 警告，即使使用 `defineChannelPluginEntry` 默认导出。install 校验与 defineChannelPluginEntry 约定存在偏差（**2026.7.1 已修，见下方问题清单 #5**） |

---

## 2. 待提交官方的问题清单（SDK / 文档偏差）

> 这些是文档与实现不符、值得回馈给 OpenClaw 官方的点。若已回馈/修复，请标注。

1. **`definePluginSetup` / `defineSetupSteps` 未实现**：`docs/plugins/sdk-entrypoints.md`
   描述了该 API，但 `openclaw/plugin-sdk/setup` 未导出。建议要么实现，要么更正文档。
   **（2026-09-10 于 9.3 复核：二符号仍不存在**——`exports` 现有 5 个 setup 相关子路径
   （`./plugin-sdk/setup`、`channel-setup`、`provider-setup`、`setup-runtime`、`setup-tools`），
   全部 .d.ts 与 dist 均无 `definePluginSetup`/`defineSetupSteps`；但 setup 面已大幅扩充
   （`defineChannelSetupContract`、`createOptionalChannelSetupAdapter`、`createClackPrompter`、
   各类 wizard helper）。偏差仍在（文档 vs 导出名），实际可用面已远好于 2026.6.11——
   本插件维持 `testConnection()` 轻量 setup 不变。）
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
   **（2026-09-10 于 2026.9.3 复核：已大幅改善——失败范围缩小为定向报错，不再阻断全局。**
   **实测**（临时改安装目录 manifest `configSchema.required: ["token"]`）：`openclaw plugins list`
   正常出全表 exit 0（仅多一条 `Persisted plugin registry no longer matches…` 漂移警告）；
   `openclaw config validate` 定向报 `plugins.entries.clawrent.config.token: must have required
   property 'token'` 并 exit 1，其余命令不受影响。7.x 时代"整个 CLI 启动失败"在 9.3 不再复现。
   本条可视为已在上游收敛；插件侧仍保持 required 空数组以兼容旧宿主。）
5. **`plugins install --link` 的入口校验与 `defineChannelPluginEntry` 不一致**：
   install 报 `missing register/activate export`，但 `defineChannelPluginEntry` 的
   返回值已含 `register`。建议统一 install 校验逻辑，或文档说明入口文件的导出约定。
   **✅ 已修复（OpenClaw 2026.7.1）**：`resolvePluginModuleExport`（loader.ts:295）已
   normalize default / module-wrapper 导出，接受 register/activate；PinkBo 在 2026.7.1-2
   复测 `onStartup:true` + `defineChannelPluginEntry`（含纯 default-export 变体）干净加载、
   不复现（openclaw/openclaw#111344 关闭为 "already implemented"）。
   **⚠️ 但 clawrent 直到 0.6.0 仍在启动报 `missing register/activate`——真因是 #7（setupEntry），不是本条。** 本条（default-export loader bug）与 clawrent 实际踩到的validation 失败是**两条不同的路径**，别混。
   **（2026-09-10 于 9.3 复核：`resolvePluginModuleExport` 仍在**（loader-runtime-load-BgaHcThS.mjs:601），7.1 的 normalize 行为延续到 9.3；本插件 0.7.0 起额外显式 re-export `register`/`activate` 双保险，实测 0.8.0 + 9.3 启动注册干净。）
7. **`openclaw.setupEntry` 被当 plugin 入口校验（2026-08-07 实测，0.7.0 已绕过）**：
   `package.json` 的 `openclaw.setupEntry` / `runtimeSetupEntry` 指向 `./dist/setup/setup.js`
   时，loader 在 setup-only / prefer-setup registration plan 下会把 setup.js 当作主入口加载
   （`loader-svIpMF0d.js:1915` `loadEntry = loadSetupEntry && runtimeSetupEntry ? runtimeSetupEntry : runtimeCandidateEntry`），
   再对它跑完整 plugin 的 register/activate 校验。而 setup.js 是 setup 接口（导出 `{testConnection}`），
   合法地没有 register/activate → 误报 `clawrent missing register/activate export` → plugin
   启动 validation 失败、不进注册 plugin 列表（只剩 channel 触发式加载的 registerFull 兜底，所以显得"非阻塞"）。
   诊断法：`OPENCLAW_PLUGIN_LOAD_DEBUG=1` 起 gateway，看 `module shape: export:object keys=__esModule,default,testConnection`
   （= setup.js 形态，非 index.js 的 entry）即铁证。`describePluginModuleExportShape`（loader:392）输出。
   **plugin 侧修法**：删 `package.json` 的 `setupEntry`/`runtimeSetupEntry`（setup 向导 testConnection
   由 `createChannelPluginBase({setup})` adapter 覆盖；setup-only 模式 fallback 加载 index.js，registerFull
   只 full 模式起 provider、setup-only 不起，安全）。**建议回馈上游**：loader 不应对 setupEntry 跑完整
   register/activate 校验（setup entry 是 `defineSetupPluginEntry`/setup 契约，非 plugin entry）。
   **（2026-09-10 于 9.3 复核：上游未改**——同一 loadEntry 逻辑仍在 9.3（loader-runtime-load-BgaHcThS.mjs:1080
   一字不差），setupEntry 被当 plugin 入口校验的机制延续；插件侧 0.7.0 绕过（package.json 已无
   `setupEntry`/`runtimeSetupEntry`，已核实）继续有效，回馈上游的建议维持。）
6. **`channelConfigs` manifest 字段文档不足**：install 警告
   "channel plugin manifest declares clawrent without channelConfigs metadata"，
   但 manifest 已声明 `channelConfigs`。需明确该字段的精确期望结构。
   （PinkBo 已通过给 `channelConfigs.clawrent` 补 `schema` 修复了加载告警。）

---

*整理：PinkBo（2026-6.11 实测）· 接管维护：ClawRent 官方 · 2026-09-10 ClawRent 于 2026.9.3 复核*
