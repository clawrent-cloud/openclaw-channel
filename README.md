# @clawrent/openclaw-channel

OpenClaw **channel plugin** that turns ClawRent rental sessions into native OpenClaw conversations, so a local **ClawRent provider agent** can answer rental requests autonomously using its own model and identity.

OpenClaw **频道插件**：把 ClawRent 租赁会话桥接成 OpenClaw 原生对话，让本地 **ClawRent provider 智能体**用自有模型与身份自动应答租户请求。

> 官方维护的通用 ClawRent 频道模板。由 ClawRent 官方基于 PinkBo 移交的原型接手开发（接管记录见 [CLAWRENT_HANDOFF.md](CLAWRENT_HANDOFF.md) 的 R1–R5 需求清单）。
>
> Officially-maintained generic ClawRent channel template. ClawRent took over the prototype handed off by PinkBo (see [CLAWRENT_HANDOFF.md](CLAWRENT_HANDOFF.md) for the handoff record and R1–R5 requirements).

## What it does / 它做什么

Bridges a ClawRent rental session into a native OpenClaw conversation channel:

把一个 ClawRent 租赁会话桥接成一个 OpenClaw 原生对话频道：

- Receives tenant messages via `@clawrent/provider`'s `ProviderClient` **WS push** (no CLI daemon / polling needed).
- Dangerous instructions are intercepted by guardrails and never drive the agent.
- Drives the OpenClaw agent for one inbound turn, then **sends the model reply back** to the ClawRent session.
- Enforces approval policy at the `onPendingApproval` end-side gate (guardrails take highest priority: dangerous categories always go to manual review).
- 用 `@clawrent/provider` 的 `ProviderClient` **WS push 接收**租户消息（无需 CLI daemon / 轮询）。
- 危险指令走护栏拦截，不驱动 agent。
- 驱动 OpenClaw agent 跑一个 inbound turn，把模型回复**回发**到 ClawRent 会话。
- 在 `onPendingApproval` 端侧门执行批准策略（护栏最高优先级：危险类永远转人工）。

## Data flow / 数据流

```
ClawRent WS push
  → ProviderClient.onMessage(session, message)        [@clawrent/provider]
  → extractDialogue()        read payload.content / type
  → checkGuardrails()        guardrail verdict (dangerous → block, don't drive agent)
  → runChannelInboundEvent({ channel:"clawrent", raw, adapter })   [openclaw/plugin-sdk]
       adapter.resolveTurn → { ctxPayload, recordInboundSession, runDispatch }
         runDispatch → dispatchReplyWithBufferedBlockDispatcher (run agent)
           → providerClient.send(sessionId, { type, payload:{content} })   // reply back to ClawRent
```

## Directory structure / 目录结构

```
openclaw-channel/
├─ openclaw.plugin.json   # plugin manifest (strict schema, includes channelConfigs.clawrent.schema)
├─ package.json           # openclaw extension entry declaration
├─ tsconfig.json          # tsc config (moduleResolution: Bundler, resolves via node_modules)
├─ src/
│  ├─ index.ts            # channel entry: defineChannelPluginEntry + createChatChannelPlugin + startProvider
│  ├─ provider.ts         # ProviderClient driving the unattended provider: onPendingApproval policy + onMessage routing
│  ├─ guardrails.ts       # guardrail verdict (built-in minimal example + external guardrailsFile)
│  └─ setup/setup.ts      # config setup entry (testConnection: token validation)
├─ docs/
│  └─ openclaw-sdk-notes.md   # OpenClaw SDK gotchas notes (docs vs reality, required reading)
└─ CLAWRENT_HANDOFF.md    # handoff notes + R1–R5 requirements list
```

## Build / verify / 构建 / 校验

```bash
npm install        # pulls openclaw (SDK types) + @clawrent/provider
npm run build      # tsc -p tsconfig.json → dist/
npm run typecheck  # type-only check, no output
```

After `npm install`, `openclaw` lands in the local `node_modules`; `moduleResolution: "Bundler"` resolves
`openclaw/plugin-sdk/*` via its `exports` allowlist, **independent of any globally-installed openclaw path**.

`npm install` 后 `openclaw` 进本地 `node_modules`，`moduleResolution: "Bundler"` 经其
`exports` 白名单解析 `openclaw/plugin-sdk/*`，**不依赖全局安装的 openclaw 路径**。

## Configuration / 配置

`plugins.entries.clawrent.config` fields:

`plugins.entries.clawrent.config` 字段：

| Field / 字段 | Required / 必填 | Description / 说明 |
|---|---|---|
| `token` | No* / 否* | ClawRent agent token. Falls back to `~/.clawrent/config.json`'s `token`/`agentToken` if absent, to keep secrets out of openclaw.json. / ClawRent agent token。缺失时回退读 `~/.clawrent/config.json` 的 `token`/`agentToken`，避免密钥写入 openclaw.json。 |
| `apiBaseUrl` | No / 否 | ClawRent API base, default `https://clawrent.cloud`. / ClawRent API 地址，默认 `https://clawrent.cloud`。 |
| `wsUrl` | No / 否 | ClawRent WebSocket URL. / ClawRent WebSocket 地址。 |
| `agentId` | No / 否 | ClawRent agent id (UUID); auto-resolved from token if omitted. / ClawRent agent id（UUID），留空由 token 自动解析。 |
| `autoApproveSessions` | No / 否 | End-side auto-approve toggle (**only effective when a session is `pending_approval`**; a separate layer from the platform `approvalMode`, see [approval-modes.md](docs/approval-modes.md)). `true` (default) = SDK auto-approves pending sessions (no approval-level guardrail run; **message-level guardrails always apply**); `false` = everything goes to manual review. / 端侧自动批准开关（**仅当会话已是 `pending_approval` 时生效**，与平台 `approvalMode` 是两层，详见 [approval-modes.md](docs/approval-modes.md)）。`true`（默认）= SDK 自动批准挂起会话（不跑批准级护栏；**消息级护栏始终生效**）；`false` = 全部转人工。 |
| `guardrailsFile` | No / 否 | External guardrail policy file (`/regex/ \|\| reason` per line, `#` comments), rules appended after the built-ins. / 外置护栏策略文件（每行 `/regex/ \|\| 原因`，`#` 注释），规则追加在内置护栏之后。 |
| `cursorPath` | No / 否 | Message cursor storage path, default `~/.clawrent/openclaw-provider-cursor.json`. / 消息游标存储路径，默认 `~/.clawrent/openclaw-provider-cursor.json`。 |

\* The token must exist in either config or `~/.clawrent/config.json`, otherwise the channel is not activated (warn only).
\* token 必须在 config 或 `~/.clawrent/config.json` 二者之一中存在，否则频道不激活（仅 warn）。

### openclaw.json example / openclaw.json 示例

```jsonc
{
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
  },
  "channels": {
    "clawrent": {
      "agentId": "019f35a8-...",
      "autoApproveSessions": true,
      "guardrailsFile": "/path/to/clawrent-guardrails.md"
    }
  }
}
```

> `plugins.entries.clawrent.config` is what the plugin reads at runtime; `channels.clawrent` selects the **gateway-managed single-instance path** (`startAccount`, health-monitor integration). **Configure both blocks.** Put the token in `~/.clawrent/config.json`, not in openclaw.json.
> （2026-09-10 于 2026.9.3 复核：删掉 `channels.clawrent` 重启实测——插件**仍会加载**，且 legacy `registerFull` 兜底与 gateway `startAccount` **两条路径同时各启动一个 provider**（日志两条 `provider started` + 两条 `presence activated`），比 7.1 时代"缺块不触发加载"更危险。两块都配，才能保证只走 gateway 托管单实例路径。详见下方 uninstall 警告与 [docs/openclaw-sdk-notes.md](docs/openclaw-sdk-notes.md) 差异表。）
>
> `plugins.entries.clawrent.config` 是 plugin 运行时读的配置；`channels.clawrent` 决定走 **gateway 托管单实例路径**（`startAccount` + health-monitor 集成）。**两块都要配**。token 放 `~/.clawrent/config.json`，不写进 openclaw.json。
> （2026-09-10 于 2026.9.3 复核：删掉 `channels.clawrent` 重启实测——插件**仍会加载**，且 legacy `registerFull` 兜底与 gateway `startAccount` **两条路径同时各启动一个 provider**（日志两条 `provider started` + 两条 `presence activated`），比 7.1 时代"缺块不触发加载"更危险。两块都配，才能保证只走 gateway 托管单实例路径。详见下方 uninstall 警告与 [docs/openclaw-sdk-notes.md](docs/openclaw-sdk-notes.md) 差异表。）

### Guardrails (guardrailsFile) / 护栏（guardrailsFile）

External guardrail file format: `/regex/ || reason` per line, `#` for comments, case-insensitive. Rules are **appended** after the built-ins (the built-ins always intercept `instruction.exec` / `read_file` / `write_file` and cannot be disabled). A message that hits a guardrail does not drive the agent; it replies with a "needs manual review" notice and routes to human review.

外置护栏文件格式：每行 `/正则/ || 原因`，`#` 开头为注释，正则大小写不敏感。规则**追加**在内置护栏之后（内置始终拦截 `instruction.exec` / `read_file` / `write_file`，不可关闭）。命中护栏的消息不驱动 agent，直接回「需人工介入」并转人工。

See [guardrails.example.md](guardrails.example.md) for a full example. Recommended minimum baseline covers at least: command execution, file read/write, delete/destruction, data exfiltration, payment/billing, publish/activate, credential harvesting, and guardrail-bypass prompts (category reference: [R3-GUARDRAILS-MATERIAL.md](R3-GUARDRAILS-MATERIAL.md)).

完整示例见 [guardrails.example.md](guardrails.example.md)。建议最低护栏基线至少覆盖：命令执行、文件读写、删除/破坏、数据外发、付费/账单、发布/激活、凭据索取、绕过护栏的 prompt（类别参考 [R3-GUARDRAILS-MATERIAL.md](R3-GUARDRAILS-MATERIAL.md)）。

> Guardrail policy currently lives entirely end-side (built-in + `guardrailsFile`). "Platform-side authoritative delivery" is the R3 goal — at that point `guardrailsFile` demotes to local override/append.
>
> 护栏策略目前完全在端侧（内置 + `guardrailsFile`）。「平台侧权威下发」是 R3 的目标——届时 `guardrailsFile` 降为本地覆盖/追加。

## Enable / 启用

1. `openclaw plugins install clawhub:@clawrent/openclaw-channel` (ClawHub, primary registry) — or `openclaw plugins install @clawrent/openclaw-channel` (npm). For development, `openclaw plugins install --link <this dir>`.
2. Configure two blocks in `~/.openclaw/openclaw.json`: `plugins.entries.clawrent.config` (read at runtime) + `channels.clawrent` (selects the gateway-managed single-instance path), see the example above; put the token in `~/.clawrent/config.json`.
3. Restart the Gateway → the plugin loads via **channel-triggered loading** (`onStartup:false`) → the gateway autostarts the account via `startAccount` → provider WS comes online → auto-accepts sessions. With `channels.clawrent` configured, the provider is **gateway-managed**: the health-monitor sees it as healthy (no false restarts) and it auto-recovers from terminal death / startup failure.

1. `openclaw plugins install clawhub:@clawrent/openclaw-channel`（ClawHub，主渠道）—— 或 `openclaw plugins install @clawrent/openclaw-channel`（npm）。开发可用 `openclaw plugins install --link <本目录>`。
2. 在 `~/.openclaw/openclaw.json` 配置两块：`plugins.entries.clawrent.config`（plugin 运行时读）+ `channels.clawrent`（选走 gateway 托管单实例路径），见上方示例；token 放 `~/.clawrent/config.json`。
3. 重启 Gateway → plugin 走 **channel 触发式加载**（`onStartup:false`）→ gateway 经 `startAccount` 自启账户 → provider WS 上线 → 自动接单。配了 `channels.clawrent` 后，provider 由 **gateway 托管**：health-monitor 判其健康（无误判 restart），且终态死亡 / 启动失败时自动恢复。

> **OpenClaw 2026.9+ (capability consent):** after installing or upgrading, the plugin sits in an
> unauthorized state and the gateway log reports `requires capability consent`. Run:
>
> ```bash
> openclaw plugins enable clawrent --accept-capabilities
> openclaw gateway restart
> ```
>
> Afterwards `openclaw channels status` should show `clawrent ... running`.
> 2026.7.x/8.x hosts have no such mechanism — skip this step.
> (Re-verified 2026-09-10 on 2026.9.3: the consent flow matches the text above — once accepted, `channels status` shows `running`.)
>
> **OpenClaw 2026.9+（capability consent）：** 安装或升级后插件处于未授权状态，
> gateway 日志会报 `requires capability consent`。执行：
>
> ```bash
> openclaw plugins enable clawrent --accept-capabilities
> openclaw gateway restart
> ```
>
> 之后 `openclaw channels status` 应显示 `clawrent ... running`。
> 2026.7.x/8.x 宿主无此机制，跳过本步。（2026-09-10 于 2026.9.3 复核：consent 机制与上述文案一致，0.8.0 已授权后 `channels status` 显示 `running`。）

> ℹ️ **`plugins.allow` is safe on 9.x**（2026-09-10 于 2026.9.3 复核）: an allow-list that includes `clawrent` coexists normally with the capability-consent model — a production gateway running `plugins.allow: ["memory-core","clawrent"]` + plugin 0.8.0 loads, registers and runs clean. The old warning below applied to the 0.3.x era and **no longer applies to 9.x hosts**: adding `allow` no longer blocks `registerFull`. Only legacy 0.3.x-era hosts need the old caution.
>
> ℹ️ **9.x 下 `plugins.allow` 安全**（2026-09-10 于 2026.9.3 复核）：含 `clawrent` 的 allow 列表与 capability consent 模型共存正常——生产网关实配 `plugins.allow: ["memory-core","clawrent"]` + plugin 0.8.0，加载、注册、运行全程无警告。旧警告属 0.3.x 时代，**对 9.x 宿主不再适用**：加 `allow` 不会再阻断 `registerFull`。仅 0.3.x 时代旧宿主需保留旧谨慎。

> ⚠️ **Keep `activation.onStartup` as `false`** (the default — don't change it). It's the cross-version-safe choice: the channel-triggered load path works on every OpenClaw build. Historically 0.2.6–0.3.1 set this to `true` and hit an OpenClaw startup-validation loader bug that mis-reported `missing register/activate` for `defineChannelPluginEntry`'s export shape, so the plugin failed to load. **That loader bug is fixed upstream as of OpenClaw 2026.7.1** (`resolvePluginModuleExport` now normalizes default / module-wrapper exports, so `true` loads cleanly too) — but there's no reason to switch: `false` works everywhere, while `true` would re-trip the bug for users still on pre-fix builds. (Re-verified 2026-09-10 on 2026.9.3: `false` + channel-triggered loading works.) Note: the old advice "after changing `onStartup` you must reinstall (`registry --refresh` is not enough)" was a 0.2.x-era finding and **is obsolete on 2026.9.3** — the 9.3 install index stores a `manifestHash` per plugin and self-invalidates on any manifest drift, falling back to a derived index built from the live manifest (verified live: editing the installed manifest immediately triggers `Persisted plugin registry no longer matches…` + derived-index fallback; source: `installed-plugin-index` / `plugin-registry-snapshot` in openclaw dist). See [docs/openclaw-sdk-notes.md](docs/openclaw-sdk-notes.md).
>
> ⚠️ **保持 `activation.onStartup` 为 `false`**（默认即如此，勿改）。这是跨版本安全的保守选择：channel 触发式加载路径在所有 OpenClaw build 上都通。历史上 0.2.6–0.3.1 曾设为 `true`，撞上 OpenClaw startup validation 的 loader bug（不认 `defineChannelPluginEntry` 产出的导出形态，误报 `missing register/activate`），导致 plugin 不加载。**该 loader bug 已在 OpenClaw 2026.7.1 上游修复**（`resolvePluginModuleExport` 已 normalize default / module-wrapper 导出，`true` 现在也能干净加载）—— 但没必要换：`false` 全 build 通用，换 `true` 会让仍在修复前 build 的用户重新踩坑。（2026-09-10 于 2026.9.3 复核：`false` + 触发式加载在 9.3 正常。）注意：旧结论「改 manifest 的 onStartup 后必须 reinstall（install record 缓存，`registry --refresh` 不够）」属 0.2.x 时代，**在 2026.9.3 已过时**——9.3 的 install index 按 plugin 记录 `manifestHash`，manifest 一变即检测漂移并回退用 live manifest 构建的 derived index（实测：改安装目录 manifest 后 CLI 立即报 `Persisted plugin registry no longer matches…` 并走 derived index；源码：openclaw dist 的 `installed-plugin-index` / `plugin-registry-snapshot`）。详见 [docs/openclaw-sdk-notes.md](docs/openclaw-sdk-notes.md)。

> ℹ️ **(0.7.0) Startup `missing register/activate` — the real cause was `setupEntry`.** Through 0.6.0 the gateway could log `clawrent missing register/activate export` at startup. This was **not** the default-export loader bug noted just above (that one is fixed upstream) — it was `package.json`'s `openclaw.setupEntry` pointing at `dist/setup/setup.js`: in setup-only plans the loader loaded `setup.js` as the plugin entry and ran the full register/activate check on it, which the setup module legitimately lacks. 0.7.0 removes `setupEntry`; the setup `testConnection` still works via the channel's `setup` adapter. With this fix the plugin registers as a normal plugin at startup and the gateway-managed `startAccount` autostart works.
>
> ℹ️ **（0.7.0）启动报 `missing register/activate` —— 真因是 `setupEntry`。** 直到 0.6.0，gateway 启动时可能报 `clawrent missing register/activate export`。这**不是**上一条说的 default-export loader bug（那条上游已修）—— 而是 `package.json` 的 `openclaw.setupEntry` 指向 `dist/setup/setup.js`：setup-only plan 下 loader 把 `setup.js` 当 plugin 入口加载并跑完整 register/activate 校验，而 setup 模块本就没有这些导出。0.7.0 删除 `setupEntry`；setup 的 `testConnection` 仍经 channel 的 `setup` adapter 可用。修复后 plugin 启动时正常注册，gateway 托管的 `startAccount` 自启才得以工作。

> ℹ️ **Channel status display（2026-09-10 于 2026.9.3 复核）**: the old warning about `channels status --deep` falsely reporting `not-running` / `disabled` is **moot on 9.x** — the `--deep` flag no longer exists on `channels status` (`OpenClaw does not recognize option "--deep"`; the deep variant moved to `openclaw status --deep` / `openclaw gateway status --deep`), and plain `channels status` reports accurately: with the gateway log showing `[clawrent] provider started`, it prints `ClawRent clawrent-provider: enabled, configured, running`. On legacy 7.x-era hosts the old display bug may still exist — judging by the gateway log `[clawrent] provider started` + the platform `onlineStatus` remains the ground truth there.
>
> ℹ️ **Channel 状态显示（2026-09-10 于 2026.9.3 复核）**：旧的「`channels status --deep` 误报 `not-running` / `disabled`」警告**在 9.x 已不适用**——`channels status` 的 `--deep` flag 已移除（报 `OpenClaw does not recognize option "--deep"`；deep 变体迁至 `openclaw status --deep` / `openclaw gateway status --deep`），且普通 `channels status` 显示准确：gateway 日志有 `[clawrent] provider started` 时输出 `ClawRent clawrent-provider: enabled, configured, running`。7.x 旧宿主上旧显示 bug 可能仍在——以 gateway 日志 `[clawrent] provider started` + 平台 onlineStatus 为准的口径仅在旧宿主保留。

> The `channels.clawrent` block **must not include an `enabled` field** (the channel schema is `additionalProperties:false`). The plugin reads `plugins.entries.clawrent.config` at runtime; `channels.clawrent` selects the **gateway-managed single-instance path** — loading itself does not depend on it. (2026-09-10 on 2026.9.3: with the block removed, the plugin still loads and both the legacy `registerFull` start and gateway `startAccount` fire, each starting a provider on the same token — see the two-block note and the uninstall warning.)
>
> `channels.clawrent` 块**不加 `enabled` 字段**（channel schema `additionalProperties:false`）。plugin 运行时读的是 `plugins.entries.clawrent.config`；`channels.clawrent` 选走 **gateway 托管单实例路径**——插件加载本身不依赖它。（2026-09-10 于 2026.9.3 复核：删掉该块后插件**仍会加载**，legacy `registerFull` 启动与 gateway `startAccount` 同时触发、各自在同一 token 上启动一个 provider——见上方两块契约说明与下方 uninstall 警告。）

> Keep `configSchema.required` in the manifest as an empty array. (Re-verified 2026-09-10 on 2026.9.3: a non-empty `required` no longer aborts the whole CLI — with `required: ["token"]` temporarily set in the installed manifest, `openclaw plugins list` still prints the full table (exit 0, plus one registry-drift warning) and `openclaw config validate` reports the scoped error `plugins.entries.clawrent.config.token: must have required property 'token'` and exits 1; the 7.x-era "entire CLI fails to start" no longer reproduces.) Keeping it empty is still recommended for cross-version safety (pre-8.x hosts did abort globally); declare fields optional + runtime warn instead.
>
> manifest 的 `configSchema.required` 保持空数组。（2026-09-10 于 2026.9.3 复核：required 非空的失败范围已从"全局阻断"缩小为**定向报错**——实测把安装目录 manifest 的 required 临时改为 `["token"]` 后，`openclaw plugins list` 正常出全表（exit 0，仅多一条 registry 漂移警告），`openclaw config validate` 报 `plugins.entries.clawrent.config.token: must have required property 'token'` 后 exit 1；7.x 时代"整个 CLI 启动失败"不再复现。）跨版本安全起见仍建议保持空数组（8.x 之前的宿主会全局崩）；字段声明为可选 + 运行时 warn。

> 💡 **Gateway-managed provider lifecycle (≥ 0.7.0)**: since `@clawrent/openclaw-channel@0.7.0`, the plugin implements OpenClaw's `gateway.startAccount` / `stopAccount`, making `clawrent` a first-class gateway-managed account. While the `startAccount` task is alive the gateway marks the account `running:true` (no `setStatus` needed), so OpenClaw's per-channel health-monitor sees the channel as healthy and **no longer false-restarts it every ~10 min**. If the provider terminally dies (`agent:dead` / activation failure) or fails to start (e.g. a bad token → 401), `startAccount` exits and the gateway runs a **bounded auto-restart** (retries transient failures; gives up after N attempts on persistent config errors). The per-agent-id singleton still guarantees at most one ProviderClient per agent (no 4009 ping-pong). With the `channels.clawrent` block configured, the gateway owns the account lifecycle exclusively. Without the block the plugin still loads — and on 2026.9.3 both the legacy `registerFull` start and gateway `startAccount` run, each starting a provider on the same token (verified 2026-09-10, see the uninstall warning below), so the single-instance guarantee only holds with the block present. You do **not** need `gateway.channelHealthCheckMinutes: 0`. (Pre-0.7.0 the health-monitor restart was a silent no-op on this plugin: it could neither see real health nor recover a dead provider, and the only workaround was disabling the monitor.) （2026-09-10 于 2026.9.3 复核：成立的是本节的 startAccount/stopAccount 生命周期与健康语义——重启后 ~29 分钟稳定窗口内恰好 1 次 `startAccount` 启动（`provider(s) started; holding account alive`），无周期性 false-restart，0 条 clawrent 相关警告/错误；`channels status` / `openclaw status --deep`（channel probe `ClawRent | OK | configured`）均与日志一致。旧口径「缺块 → 回退 legacy registerFull、无 gateway 集成」已被实测取代：缺块时 startAccount 仍运行，实况为双路径双启动，见上方改写与下方 uninstall 警告。）
>
> 💡 **gateway 托管的 provider 生命周期（≥ 0.7.0）**：`@clawrent/openclaw-channel@0.7.0` 起实现 OpenClaw 的 `gateway.startAccount` / `stopAccount`，`clawrent` 成为 gateway 托管的一等账户。`startAccount` 任务存活期间 gateway 自动把账户记 `running:true`（无需 `setStatus`），OpenClaw 的 per-channel health-monitor 据此判健康，**不再每 ~10min 误判 restart**。provider 终态死亡（`agent:dead` / 激活失败）或启动失败（如坏 token → 401）时 `startAccount` 退出，gateway 走 **bounded auto-restart**（瞬态故障重试；持久配置错误给足次数后放弃）。per-agent-id 单例仍保证每 agent 至多一个 ProviderClient（无 4009 乒乓）。**配置 `channels.clawrent` 块时，账户生命周期完全由 gateway 托管**。缺块时插件仍会加载——且 2026.9.3 上 legacy `registerFull` 启动与 gateway `startAccount` **都会运行、各自在同一 token 上启动一个 provider**（2026-09-10 实测，见下方 uninstall 警告），单实例保证仅在块存在时成立。**无需 `gateway.channelHealthCheckMinutes: 0`**。（0.7.0 之前 health-monitor restart 对本插件是静默 no-op：既看不到真实健康、也无法恢复死亡 provider，唯一 workaround 是关掉监控。）（2026-09-10 于 2026.9.3 复核：成立的是本节的 startAccount/stopAccount 生命周期与健康语义——重启后 ~29 分钟稳定窗口内恰好 1 次 `startAccount` 启动（`provider(s) started; holding account alive`），无周期性 false-restart，0 条 clawrent 相关警告/错误；`channels status` / `openclaw status --deep`（channel probe `ClawRent | OK | configured`）均与日志一致。旧口径「缺块 → 回退 legacy registerFull、无 gateway 集成」已被实测取代：缺块时 startAccount 仍运行，实况为双路径双启动，见上方改写与下方 uninstall 警告。）
>
> ⚠️ **One provider per agent token**: the idempotent guard above only prevents **in-process** double-load (OpenClaw calling `registerFull` twice, or a health-monitor restart overlap). It **cannot** prevent two **separate processes** from using the same agent token — e.g. running this OpenClaw plugin **and** an MCP `clawrent_start_serving` on the same token, or two OpenClaw gateways. Two processes are invisible to each other and will 4009-kick each other into a stable oscillation (presence reconnecting every 1–2s, messages dropped in the gaps). Run exactly one provider per agent token.
>
> ⚠️ **每个 agent token 只跑一个 provider**：上面的幂等保护只防**进程内**双加载（OpenClaw 两次调 `registerFull`、或 health-monitor 重启叠加）。它**防不了**两个**独立进程**用同一个 agent token —— 例如同一 token 既跑本 OpenClaw plugin、**又**跑 MCP `clawrent_start_serving`，或两个 OpenClaw 网关。两个进程互不可见，会互相 4009 踢成稳态振荡（presence 每 1–2s 重连一轮，间隙丢消息）。**每个 agent token 只跑一个 provider。**

### Migrate from a community fork / 从社区 fork 迁移

If you previously installed a community fork (same manifest `id` `clawrent` as the official package), make the old fork stop loading **before** installing the official package; otherwise the two coexist and trigger a `duplicate plugin id` warning, and config precedence may silence one of them:

若先前装过社区 fork（与官方包 manifest `id` 同为 `clawrent`），装官方包前**先让旧 fork 不再加载**，否则两者共存会触发 `duplicate plugin id` 警告，config 优先级可能使其中一个不生效：

- Old fork loaded via `plugins.load.paths` → remove the fork dir from `load.paths`.
- Old fork installed via `plugins install` → `openclaw plugins uninstall <old fork package name>`.
- 旧 fork 经 `plugins.load.paths` 加载 → 从 `load.paths` 移除旧 fork 目录；
- 旧 fork 经 `plugins install` 安装 → `openclaw plugins uninstall <旧 fork 包名>`。

After that the official package is the only `clawrent` resolution source. `plugins.entries.clawrent.config` **needs no changes** (the official manifest `id` is still `clawrent`, config keys are compatible).

之后官方包成为唯一 `clawrent` 解析源。`plugins.entries.clawrent.config` **无需改动**（官方包 manifest `id` 仍为 `clawrent`，配置 key 兼容）。

### Upgrade / 升级

```bash
openclaw plugins uninstall clawrent --force
openclaw plugins install @clawrent/openclaw-channel@<version>
openclaw gateway restart
```

After the upgrade completes (OpenClaw 2026.9+ hosts):

```bash
openclaw plugins update clawrent --accept-capabilities   # or enable --accept-capabilities after install
openclaw gateway restart
```

When the capability surface (declared channels / tools / hooks, etc.) changes, 9.x forces re-authorization — this is expected behavior.

升级完成后（OpenClaw 2026.9+ 宿主）：

```bash
openclaw plugins update clawrent --accept-capabilities   # 或 install 后 enable --accept-capabilities
openclaw gateway restart
```

能力面（channels/tools/hooks 等声明）有增减时，9.x 会强制重新授权，属预期行为。

> ⚠️ **`openclaw plugins uninstall --force` removes the `channels.clawrent` config block** from `~/.openclaw/openclaw.json` (including `agentId` / `autoApproveSessions` / `guardrailsFile` — **not the token**: the token always stays in `~/.clawrent/config.json`, credentials are unaffected). The subsequent `install` **does not recreate** that block. After upgrading, **verify `channels.clawrent` is still present**; if it was removed, restore it from the pre-uninstall backup (`openclaw.json.bak.*`) or re-fill it per the [Configuration](#configuration--配置) section (`agentId` can be left empty to auto-resolve from the token). As of plugin 0.7.0 (gateway-managed lifecycle), the `channels.clawrent` block is **required**: when missing, the plugin still loads and **two load paths each start a provider on the same agent token** (legacy `registerFull` start + gateway `startAccount`) — two presences on one agent, risking 4009 kicks / roster churn. The gateway-managed single-instance `startAccount` path (stable, health-monitor-friendly) is only guaranteed when `channels.clawrent` is present. **After `uninstall`, you MUST add back `channels: { clawrent: {} }` (or restore from backup) before restarting the gateway.** This behavior stems from the OpenClaw CLI's `uninstall` design (reported upstream); the plugin cannot intercept it. （2026-09-10 于 2026.9.3 复核：**仍未修**——9.3 源码 `uninstall-config` 的 `removePluginRuntimePolicyFromConfig` 依旧在卸载时删除 `channels.<channelIds>` + `plugins.entries.<id>` 并把 `<id>` 移出 `plugins.allow`（命令链：`plugins uninstall` → `management-uninstall` → `uninstall-DRcXuyKg.mjs:270`）；生产机禁跑活卸载实验，以上为源码级确认。缺块后果亦于 9.3 实测：即上文机制——legacy `registerFull` 与 gateway `startAccount` 双路径各启动一个 provider（2 条 `provider started` + 2 条 `presence activated`，~2.5 分钟观测窗口内未及出现 roster 风暴即已恢复，双 presence 风险成立）——**本警告在 9.3 继续有效**。）
>
> ⚠️ **`openclaw plugins uninstall --force` 会删除 `channels.clawrent` 配置块**（含 `agentId` / `autoApproveSessions` / `guardrailsFile`，**不含 token** —— token 始终在 `~/.clawrent/config.json`，凭据不受影响），随后的 `install` **不会重建**该块。升级后**请检查 `channels.clawrent` 是否还在**；若被删，从卸载前的备份（`openclaw.json.bak.*`）恢复，或按[配置](#configuration--配置)章节重新填写（`agentId` 可留空由 token 自动解析）。plugin 0.7.0 起（gateway 托管生命周期）`channels.clawrent` 块**必需**：缺失时插件仍会加载，且**两条加载路径在同一 agent token 上各启动一个 provider**（legacy `registerFull` 启动 + gateway `startAccount`）——同一 agent 双 presence，有 4009 互踢 / roster 混乱风险。gateway 托管单实例 `startAccount` 路径（稳定、health-monitor 友好）仅在 `channels.clawrent` 存在时才有保证。**`uninstall` 后、重启 gateway 前务必加回 `channels: { clawrent: {} }`（或从备份恢复）。**此行为源自 OpenClaw CLI 的 uninstall 设计（已向上游反馈），插件侧无法干预。（2026-09-10 于 2026.9.3 复核：**仍未修**——9.3 源码 `uninstall-config` 的 `removePluginRuntimePolicyFromConfig` 依旧在卸载时删除 `channels.<channelIds>` + `plugins.entries.<id>` 并把 `<id>` 移出 `plugins.allow`；生产机禁跑活卸载实验，源码级确认。缺块后果亦于 9.3 实测：即上文机制——双路径各启动一个 provider（2 条 `provider started` + 2 条 `presence activated`，~2.5 分钟观测窗口内未及出现 roster 风暴即已恢复，双 presence 风险成立）——**本警告在 9.3 继续有效**。）

## Design notes / 设计要点

- **WS push inbound**: receives pushes via `@clawrent/provider`'s `ProviderClient`; no polling, no CLI daemon.
- **Native guardrails**: `guardrails.ts` ships a minimal built-in safety example (intercepts structured `instruction.*`); full policy is externally appended via `guardrailsFile` — the plugin binds to no single provider's agenda and works as a generic channel template.
- **Identity consistency**: the platform answer is the local provider agent (same token / persona); growth syncs naturally via workspace files.
- **End-side approval gate**: `onPendingApproval` is the sole approval gate; guardrails take highest priority (dangerous always goes to manual), the rest follow `autoApproveSessions`. See the handoff doc §2.2 on the known limitation that "the platform autoApprove state is not exposed by the SDK".
- **WS push inbound**：经 `@clawrent/provider` 的 `ProviderClient` 接收推送，不轮询、无需 CLI daemon。
- **护栏原生**：`guardrails.ts` 内置最小安全示例（拦结构化 `instruction.*`），完整策略由 `guardrailsFile` 外置追加——plugin 不绑任何一家 provider 的私货，可作通用频道模板。
- **身份一致**：平台答案即本地 provider agent（同 token / persona），成长通过 workspace 文件自然同步。
- **端侧批准门**：`onPendingApproval` 是唯一批准闸门；护栏最高优先级（危险永远转人工），其余跟随 `autoApproveSessions`。详见移交文档 §2.2 关于「平台 autoApprove 状态 SDK 不暴露」的已知限制。

## Typing indicator (v0.2.0+) / Typing 指示器（v0.2.0+）

While the provider agent generates a reply, it sends a `dialogue.typing` control signal to the consumer, who shows a "provider is typing" indicator — filling the UX gap before the reply arrives.

provider agent 驱动回复时，向 consumer 发送 `dialogue.typing` 控制信号，consumer 侧显示「provider 正在输入」，填补 provider 生成回复前的 UX 空窗。

- **Depends on** `@clawrent/provider@^0.4.0` (`ProviderClient.sendTyping`) + ClawRent backend typing short-circuit (`dialogue.typing` is short-circuited before `validateMessage`, not persisted, not metered).
- **Trigger**: fires once at `runDispatch` entry, then heartbeats every **800ms** during generation (the SDK has a built-in 500ms/session debounce; the 800ms interval ensures each heartbeat actually sends); `clearInterval` stops when the reply is sent or dispatch errors.
- **WS-only**: `sendTyping` only goes over WS. Silently returns `false` if WS is not connected, without affecting the reply main path (`client.send` still does WS+REST fallback). REST `POST /messages` persists messages, so it is **not** used for typing.
- The consumer-side typing indicator typically fades ~3s after the last typing signal; an 800ms heartbeat keeps it alive, and it is naturally replaced when the reply arrives.
- **依赖** `@clawrent/provider@^0.4.0`（`ProviderClient.sendTyping`）+ ClawRent 后端 typing 短路（`dialogue.typing` 在 `validateMessage` 之前短路转发，不持久化、不计 metering）。
- **触发**：`runDispatch` 入口立即发一次，生成期间每 **800ms** 心跳重发（SDK 内置 500ms/session 防抖，800ms 间隔保证每次都真发）；回复发出或 dispatch 出错即 `clearInterval` 停止。
- **WS-only**：`sendTyping` 只走 WS。WS 未连接时静默返回 `false`，不影响回复主路（`client.send` 仍走 WS+REST fallback）。REST `POST /messages` 会持久化消息，**不**用于 typing。
- consumer 侧 typing 指示器通常在收到最后一条 typing 后约 3s 消失；800ms 心跳足以保活，回复到达后自然替换。

## More / 更多

- [docs/openclaw-sdk-notes.md](docs/openclaw-sdk-notes.md) — OpenClaw Channel Plugin SDK empirical fact table + the list of issues to file upstream (required reading for development/upgrades). / OpenClaw Channel Plugin SDK 实测事实表 + 待提交官方的问题清单（开发/升级必读）。
- [CLAWRENT_HANDOFF.md](CLAWRENT_HANDOFF.md) — handoff notes + R1–R5 requirements list (approval structured policy / platform-delivered guardrails / autoApprove semantics documentation, etc.). / 移交说明 + R1–R5 需求清单（approval 结构化策略 / 护栏平台下发 / autoApprove 语义文档化 等）。
