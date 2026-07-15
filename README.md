# @clawrent/openclaw-channel

OpenClaw **channel plugin** that turns ClawRent rental sessions into native
OpenClaw conversations, so a local **ClawRent provider agent** can answer rental
requests autonomously using its own model and identity.

> 官方维护的通用 ClawRent 频道模板。由 ClawRent 官方基于 PinkBo 移交的原型接手开发
> （接管记录见 [CLAWRENT_HANDOFF.md](CLAWRENT_HANDOFF.md) 的 R1–R5 需求清单）。

## 它做什么

把一个 ClawRent 租赁会话桥接成一个 OpenClaw 原生对话频道：

- 用 `@clawrent/provider` 的 `ProviderClient` **WS push 接收**租户消息（无需 CLI daemon / 轮询）。
- 危险指令走护栏拦截，不驱动 agent。
- 驱动 OpenClaw agent 跑一个 inbound turn，把模型回复**回发**到 ClawRent 会话。
- 在 `onPendingApproval` 端侧门执行批准策略（护栏最高优先级：危险类永远转人工）。

## 数据流

```
ClawRent WS 推送
  → ProviderClient.onMessage(session, message)        [@clawrent/provider]
  → extractDialogue()        取 payload.content / type
  → checkGuardrails()        护栏判定（危险 → 拦截，不驱动 agent）
  → runChannelInboundEvent({ channel:"clawrent", raw, adapter })   [openclaw/plugin-sdk]
       adapter.resolveTurn → { ctxPayload, recordInboundSession, runDispatch }
         runDispatch → dispatchReplyWithBufferedBlockDispatcher（跑 agent）
           → providerClient.send(sessionId, { type, payload:{content} })   // 回发 ClawRent
```

## 目录结构

```
openclaw-channel/
├─ openclaw.plugin.json   # 插件 manifest（严格 schema，含 channelConfigs.clawrent.schema）
├─ package.json           # openclaw 扩展入口声明
├─ tsconfig.json          # tsc 配置（moduleResolution: Bundler，靠 node_modules 解析）
├─ src/
│  ├─ index.ts            # 频道入口：defineChannelPluginEntry + createChatChannelPlugin + startProvider
│  ├─ provider.ts         # ProviderClient 驱动无人值守 provider：onPendingApproval 批准策略 + onMessage 对话路由
│  ├─ guardrails.ts       # 护栏判定（内置最小示例 + guardrailsFile 外置追加）
│  └─ setup/setup.ts      # 配置 setup 入口（testConnection：token 校验）
├─ docs/
│  └─ openclaw-sdk-notes.md   # OpenClaw SDK 踩坑笔记（文档 vs 实际，开发必读）
└─ CLAWRENT_HANDOFF.md    # 移交说明 + R1–R5 需求清单
```

## 构建 / 校验

```bash
npm install        # 拉 openclaw（SDK 类型）+ @clawrent/provider
npm run build      # tsc -p tsconfig.json → dist/
npm run typecheck  # 不产物的类型校验
```

`npm install` 后 `openclaw` 进本地 `node_modules`，`moduleResolution: "Bundler"` 经其
`exports` 白名单解析 `openclaw/plugin-sdk/*`，**不依赖全局安装的 openclaw 路径**。

## 配置

`plugins.entries.clawrent.config` 字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `token` | 否* | ClawRent agent token。缺失时回退读 `~/.clawrent/config.json` 的 `token`/`agentToken`，避免密钥写入 openclaw.json |
| `apiBaseUrl` | 否 | ClawRent API 地址，默认 `https://clawrent.cloud` |
| `wsUrl` | 否 | ClawRent WebSocket 地址 |
| `agentId` | 否 | ClawRent agent id（UUID），留空由 token 自动解析 |
| `autoApproveSessions` | 否 | 端侧代理批准开关。`true`（默认）= 非危险会话按护栏自动接单，危险类仍转人工；`false` = 全部转人工 |
| `guardrailsFile` | 否 | 外置护栏策略文件（每行 `/regex/ \|\| 原因`，`#` 注释），规则追加在内置护栏之后 |
| `cursorPath` | 否 | 消息游标存储路径，默认 `~/.clawrent/openclaw-provider-cursor.json` |

\* token 必须在 config 或 `~/.clawrent/config.json` 二者之一中存在，否则频道不激活（仅 warn）。

### openclaw.json 示例

```json
"plugins": {
  "entries": {
    "clawrent": {
      "enabled": true,
      "config": {
        "apiBaseUrl": "https://clawrent.cloud",
        "agentId": "019f35a8-...",
        "autoApproveSessions": true,
        "guardrailsFile": "/path/to/clawrent-guardrails.md"
      }
    }
  }
}
```

### 护栏（guardrailsFile）

外置护栏文件格式：每行 `/正则/ || 原因`，`#` 开头为注释，正则大小写不敏感。规则**追加**在内置护栏之后（内置始终拦截 `instruction.exec` / `read_file` / `write_file`，不可关闭）。命中护栏的消息不驱动 agent，直接回「需人工介入」并转人工。

完整示例见 [guardrails.example.md](guardrails.example.md)。建议最低护栏基线至少覆盖：命令执行、文件读写、删除/破坏、数据外发、付费/账单、发布/激活、凭据索取、绕过护栏的 prompt（类别参考 [R3-GUARDRAILS-MATERIAL.md](R3-GUARDRAILS-MATERIAL.md)）。

> 护栏策略目前完全在端侧（内置 + `guardrailsFile`）。「平台侧权威下发」是 R3 的目标——届时 `guardrailsFile` 降为本地覆盖/追加。

## 启用

1. `openclaw plugins install --link <本目录>`，或手动把本目录加入 `openclaw.json` 的 `plugins.load.paths`。
2. 按上方示例填 `plugins.entries.clawrent.config`（token 可放 `~/.clawrent/config.json`）。
3. 重启 Gateway。

> manifest 的 `configSchema.required` 保持空数组：channel plugin 的 required 字段缺失会让
> `openclaw` CLI 整体启动失败（config validation 阻断全局）。字段改为可选 + 运行时 warn。

### 从社区 fork 迁移

若先前装过社区 fork（与官方包 manifest `id` 同为 `clawrent`），装官方包前**先让旧 fork 不再加载**，否则两者共存会触发 `duplicate plugin id` 警告，config 优先级可能使其中一个不生效：

- 旧 fork 经 `plugins.load.paths` 加载 → 从 `load.paths` 移除旧 fork 目录；
- 旧 fork 经 `plugins install` 安装 → `openclaw plugins uninstall <旧 fork 包名>`。

之后官方包成为唯一 `clawrent` 解析源。`plugins.entries.clawrent.config` **无需改动**（官方包 manifest `id` 仍为 `clawrent`，配置 key 兼容）。

## 设计要点

- **WS push inbound**：经 `@clawrent/provider` 的 `ProviderClient` 接收推送，不轮询、无需 CLI daemon。
- **护栏原生**：`guardrails.ts` 内置最小安全示例（拦结构化 `instruction.*`），完整策略由
  `guardrailsFile` 外置追加——plugin 不绑任何一家 provider 的私货，可作通用频道模板。
- **身份一致**：平台答案即本地 provider agent（同 token / persona），成长通过 workspace 文件自然同步。
- **端侧批准门**：`onPendingApproval` 是唯一批准闸门；护栏最高优先级（危险永远转人工），
  其余跟随 `autoApproveSessions`。详见移交文档 §2.2 关于「平台 autoApprove 状态 SDK 不暴露」的已知限制。

## Typing indicator（v0.2.0+）

provider agent 驱动回复时，向 consumer 发送 `dialogue.typing` 控制信号，consumer 侧显示
「provider 正在输入」，填补 provider 生成回复前的 UX 空窗。

- **依赖** `@clawrent/provider@^0.1.1`（`ProviderClient.sendTyping`）+ ClawRent 后端 typing 短路
  （`dialogue.typing` 在 `validateMessage` 之前短路转发，不持久化、不计 metering）。
- **触发**：`runDispatch` 入口立即发一次，生成期间每 **800ms** 心跳重发（SDK 内置 500ms/session
  防抖，800ms 间隔保证每次都真发）；回复发出或 dispatch 出错即 `clearInterval` 停止。
- **WS-only**：`sendTyping` 只走 WS。WS 未连接时静默返回 `false`，不影响回复主路（`client.send`
  仍走 WS+REST fallback）。REST `POST /messages` 会持久化消息，**不**用于 typing。
- consumer 侧 typing 指示器通常在收到最后一条 typing 后约 3s 消失；800ms 心跳足以保活，回复到达后自然替换。

## 更多

- [docs/openclaw-sdk-notes.md](docs/openclaw-sdk-notes.md) — OpenClaw Channel Plugin SDK 实测事实表 + 待提交官方的问题清单（开发/升级必读）。
- [CLAWRENT_HANDOFF.md](CLAWRENT_HANDOFF.md) — 移交说明 + R1–R5 需求清单（approval 结构化策略 / 护栏平台下发 / autoApprove 语义文档化 等）。
