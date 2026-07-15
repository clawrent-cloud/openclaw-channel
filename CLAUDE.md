# CLAUDE.md — clawrent-channel-plugin

OpenClaw **channel plugin**:把 ClawRent 租赁会话桥接成 OpenClaw 原生对话,让本地 provider agent 用自有模型/身份自动应答租户。**官方维护的通用 ClawRent 频道模板**(2026-07-14 自 PinkBo 移交接手)。

> 独立 git 仓库(workspace 第 3 个项目)。消费 `@clawrent/provider`(从 npm 拉,下游关系,非 workspace)。

## 技术栈

- TypeScript(strict),`tsc` 编译(`moduleResolution: Bundler`,靠 node_modules 解析)
- `openclaw` plugin-sdk(`openclaw/plugin-sdk/*`,devDep 提供类型;运行时由 OpenClaw 加载)
- `@clawrent/provider` 的 `ProviderClient`(WS push 收消息 + 回发)
- npm(非 pnpm——OpenClaw 生态是 npm)

## 命令

```bash
npm install        # 拉 openclaw(SDK 类型)+ @clawrent/provider
npm run build      # tsc → dist/
npm run typecheck  # 不产物的类型校验
```

## 架构(数据流)

```
ClawRent WS 推送 → ProviderClient.onMessage(session, message)
  → extractDialogue() 取 payload.content / type
  → checkGuardrails() 危险 → 拦截(不驱动 agent)
  → runChannelInboundEvent({ channel:"clawrent", raw, adapter })
       adapter.resolveTurn → runDispatch
         → dispatchReplyWithBufferedBlockDispatcher(跑 agent)
           → client.send(sessionId, { type, payload:{content} })  回发 ClawRent
```

runDispatch 入口挂 `client.sendTyping` + 800ms 心跳(`return await` + `finally clearInterval`)。

## 关键文件

- `src/index.ts` — 频道入口(defineChannelPluginEntry + createChatChannelPlugin + startProvider),读 config(token 回退 `~/.clawrent/config.json`)
- `src/provider.ts` — ProviderClient 驱动:`onPendingApproval` 批准策略 + `onMessage` 对话路由 + sendTyping
- `src/guardrails.ts` — 护栏(内置最小 `instruction.*` + `guardrailsFile` 外置追加)
- `src/setup/setup.ts` — 配置 setup(testConnection:token 校验)
- `openclaw.plugin.json` — manifest(含 `channelConfigs.clawrent.schema`,**`configSchema.required` 必须为空**)

## 红线 / 易踩

- **manifest `configSchema.required` 必须空数组**:required 字段缺失会让整个 `openclaw` CLI 启动失败(config validation 阻断全局)。字段改可选 + 运行时 warn。
- **typing 是 WS-only**:`sendTyping` 只走 WS(REST `POST /messages` 会持久化,绝不用于 typing)。WS 不通时静默 false,不影响 `client.send` 的 WS+REST fallback 主路。
- **`onPendingApproval` 读不到平台 autoApprove 状态**:SDK 不暴露;目前是「平台 false + 端侧代理」约定基线。这是 R1/R4 要解决的。
- **护栏不绑私货**:内置仅最小安全示例,完整策略走 `guardrailsFile` 外置(待 R3 改为平台下发)。
- **构建移植性**:`tsconfig` 不含硬编码机器路径,任意机器 `npm install` 即可 build。openclaw 的 `exports` 白名单已暴露用到的 4 个 plugin-sdk 子路径。

## 与其他项目的关系

- **下游消费 `@clawrent/provider`**(从 npm):用 `ProviderClient` / `ApiClient` / `FileCursorStore`。当前 `^0.1.1`(sendTyping)。SDK 改 API 时本 plugin 需同步。
- 不依赖 clawrent 主仓库或 toolkit 的 workspace 链接。

## 文档索引

- [`CLAWRENT_HANDOFF.md`](CLAWRENT_HANDOFF.md) — PinkBo 移交说明 + **R1–R5 需求清单**(approval 结构化策略 / 收编 / 护栏平台下发 / autoApprove 文档化 / presence 评估)
- [`R3-GUARDRAILS-MATERIAL.md`](R3-GUARDRAILS-MATERIAL.md) — R3(护栏平台下发)的需求素材:危险指令清单
- [`docs/openclaw-sdk-notes.md`](docs/openclaw-sdk-notes.md) — OpenClaw Channel Plugin SDK 实测事实表 + 待提交官方问题清单(**开发/升级 openclaw 必读**)
- [`README.md`](README.md) — 架构 / 配置 / 启用 / Typing indicator
- 工作空间 `.plans/clawrent-channel-plugin/` — 本项目 plan/spec

## 发布分发

**待定**(讨论中)。OpenClaw `plugins install` 支持:path / archive / **npm spec** / git repo / **`clawhub:package`** / marketplace。官方插件最可能走 ClawHub(`clawhub package publish`,owner `@clawrent`,对称于已有的 skill 发布)。定稿后更新本节 + 工作空间根「发布流程参考」。
