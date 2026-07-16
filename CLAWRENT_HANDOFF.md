# ClawRent × OpenClaw Channel Plugin — 移交说明 / Handoff

> **定位:** 本仓库当前由需求方(我们)基于 `@clawrent/provider@0.1.0` 做出一个**可运行的原型 plugin**。
> 现决定 **交由 ClawRent 官方进行后续开发**,我们退居**需求方**角色,只提需求与验收。
> 本文档是移交说明 + 需求清单,供官方接手时快速对齐。

---

## 1. 当前 plugin 做了什么(架构速览)

把 ClawRent 租赁会话变成 OpenClaw 原生对话频道,让本地 provider agent 用自有模型/身份自动应答租户。

```
ClawRent WS 推送
  → ProviderClient.onMessage(session, message)        [@clawrent/provider]
  → extractDialogue() 取 payload.content / type
  → checkGuardrails() 护栏判定(危险指令直接拦截,不驱动 agent)
  → runChannelInboundEvent({ channel:"clawrent", raw, adapter })   [openclaw/plugin-sdk]
       adapter.resolveTurn → { ctxPayload, recordInboundSession, runDispatch }
         runDispatch → dispatchReplyWithBufferedBlockDispatcher(跑 agent)
           → providerClient.send(sessionId, { type, payload:{content} })  // 回发 ClawRent
```

**关键文件:**
- `src/index.ts` — 频道入口:`openclaw.plugin.json` 的 `activation.onChannels: ["clawrent"]` 挂载点;读配置(token/apiBaseUrl/wsUrl/agentId/autoApproveSessions/guardrailsFile)。
- `src/provider.ts` — 用 `ProviderClient` 驱动无人值守 provider;含 `onPendingApproval` 批准策略与 `onMessage` 对话路由。
- `src/guardrails.ts` — 护栏判定:**内置最小安全示例**(仅拦结构化 `instruction.exec/read_file/write_file`)+ 支持 `guardrailsFile` 外置规则追加。
- `src/setup/setup.ts` — 配置 setup 入口(token 校验)。
- `openclaw.plugin.json` — manifest,含已补全的 `channelConfigs.clawrent.schema`(消掉 OpenClaw 的 INFO 提示)。

---

## 2. 已验证的关键结论(官方可复用,无需重踩)

1. **manifest `channelConfigs` 必须带 `schema`**
   - OpenClaw 的 `normalizeChannelConfigs()` 只识别带 `schema`(JSON Schema draft-07)的条目;否则整条被跳过,加载时打 `declares <channel> without channelConfigs metadata` 的 warn。
   - 修复:给 `channelConfigs.clawrent` 补 `schema`(覆盖 `plugins.entries.clawrent.config` 实际字段),并带 `label`/`description`/`uiHints`。

2. **`onPendingApproval` 是端侧唯一批准闸门,SDK 不暴露平台 autoApprove 状态**
   - `@clawrent/provider` 的 `onPendingApproval: (session: ActiveSession) => boolean`,入参 `ActiveSession` **不含平台 dashboard 的 autoApprove 设置**。
   - `ProviderClientOptions.autoApprove` 是端侧传给 SDK 的开关,SDK 在连 `/ws/session` 时"代平台"执行 approve。
   - **结论:无法运行时读平台意图,只能靠"约定基线"对齐**(平台设 false + 端侧代理)。

3. **护栏策略应外置,不写死在 plugin**
   - 原型里 `guardrails.ts` 内置了最小示例,完整规则由 `guardrailsFile`(每行 `/regex/ || 原因`)外置。
   - 这样 plugin 不绑任何一家 provider 的私货,可被官方收编为通用频道模板。

---

## 3. 需求清单(我们作为需求方提的)

| # | 需求 | 优先级 | 说明 |
|---|---|---|---|
| R1 | **平台下发的 approval 事件携带结构化策略** | P0 | 当前 `onPendingApproval` 入参不含平台策略,端侧只能自判/透传。希望平台在 pending 事件里下发"允许/拦截/需人工"的结构化决策或策略引用,端侧消费而非自写规则。 |
| R2 | **plugin 作为官方通用 ClawRent channel 模板被收编/共建** | P0 | 当前是需求方 fork。希望官方接管,做成任何 ClawRent provider 都能直接复用的标准频道,而非仅我们一家。 |
| R3 | **护栏/危险指令清单由平台侧定义并下发** | P1 | "什么是危险指令"应是平台权威源;端侧 `guardrailsFile` 作为本地覆盖/追加,不替代平台。 |
| R4 | **`autoApprove` 语义在平台与 SDK 间对齐文档化** | P1 | 当前 `ProviderClientOptions.autoApprove`(端侧代理)与平台 dashboard `autoApprove`(平台侧)容易混淆,需官方出一份明确的职责划分文档。 |
| R5 | **presence / 纯 REST 上线(原 P0-2)是否仍需要** | P2 | ✅ **已评估并关闭(2026-07-16)**:WS-only 是设计决策,不补 REST presence。SDK 维持 `/ws/agent` 即在线(presence + session.new 事件 + 心跳),无 REST presence 通道。结论见 [toolkit README Presence 节](https://github.com/clawrent-cloud/agent-toolkit#readme) + skill External Runtime。仅当未来出现维持不了 WS 的 serverless/edge provider 运行时再重评估。 |

---

## 4. 移交文件清单

**交付给官方(本仓库内容):**
- `src/`(index.ts / provider.ts / guardrails.ts / setup/setup.ts)— 已泛化品牌字眼,无需求方私货。
- `openclaw.plugin.json` — manifest(含已修的 channelConfigs)。
- `package.json` / `package-lock.json` / `tsconfig.json` — 构建配置。
- `README.md` — 现有说明(官方可重写)。
- `CLAWRENT_HANDOFF.md` — 本文档。

**不交付(需求方私产,官方无需关心):**
- `clawrent-guardrails.md`(workspace 根,我们与 Pink 共维护的边界文件)— 它是 R3 需求的**来源素材**,可提炼成需求文档给对方,但不作为 plugin 代码。
- `node_modules/` / `dist/` — 构建产物,官方自行 `npm install` + `npm run build`。
- `AGENTS.md` / `SOUL.md` / `USER.md` 等 OpenClaw workspace 私有配置。

**移交前已做的清理:**
- 删除旧 REST 轮询 `src/inbound.ts`(早已重构删掉)与探测脚本 `probe-inbound.mjs`;`src` 现仅 4 个运行时代码文件。
- 源码内 "PinkBo" 品牌字眼已全部泛化为 "provider"。
- `tsconfig.json` 修了 TS6 下已移除的 `baseUrl` 选项(`npm run build` 通过)。

---

## 5. 当前已知限制 / 待官方决策

- `onPendingApproval` 无法读平台 autoApprove 状态(见 §2.2),批准策略目前是"平台 false + 端侧代理"的约定基线,非运行时联动。
- 护栏内置规则已精简为最小示例,完整策略依赖 `guardrailsFile` 外置——移交后应由 R3 接管。
- `autoApproveSessions`(端侧)默认 `true`(非危险按护栏自动接单,危险转人工);如官方接管,建议该默认值与平台策略联动决策。

---

> **移交日期:** 2026-07-14
> **移交方:** PinkBo(需求方)  ·  **接手方:** ClawRent 官方开发
> **SDK 基线:** `@clawrent/provider@0.1.0`
