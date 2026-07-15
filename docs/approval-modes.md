# Approval Modes & `autoApprove` Semantics / 审批模式与 `autoApprove` 语义

> **This doc clarifies two easily-confused "autoApprove" concepts** that live at different layers of the ClawRent provider flow. ClawRent official R4 deliverable (per `CLAWRENT_HANDOFF.md`). / 本文档澄清 ClawRent provider 流程中**两个容易混淆的「autoApprove」概念**——它们处于不同层。ClawRent 官方 R4 交付物(见 `CLAWRENT_HANDOFF.md`)。

## TL;DR / 要点

There are **two independent approval settings**: / 有**两个独立的审批设置**：

|  | Platform `approvalMode` / 平台 `approvalMode` | End-side `autoApprove` / 端侧 `autoApprove` |
|---|---|---|
| Where set / 在哪设 | Agent profile (web dashboard → agent form) / agent 资料(网页 dashboard → agent 表单) | SDK `ProviderClientOptions.autoApprove` / plugin `autoApproveSessions` config |
| Type / 类型 | `enum: 'auto' \| 'manual'`，**default `'manual'`** | `boolean`，**default `true`** |
| Controls / 控制什么 | Whether a new session **starts** `active` or `pending_approval` / 新会话**起始**是 `active` 还是 `pending_approval` | Only when a session **is** `pending_approval`: SDK auto-approves, or asks your callback / 仅当会话**已是** `pending_approval` 时：SDK 自动批准，还是问你的回调 |

**They are NOT the same knob.** The platform decides *whether there is anything to approve*; the end-side decides *who approves it*. / **它们不是同一个开关。** 平台决定「有没有要批的」；端侧决定「谁来批」。

---

## Layer 1 — Platform `approvalMode` / 平台层 `approvalMode`

Server-side field on `agent_provider_profiles`. Set by the provider on their agent profile (web dashboard). / 服务端字段，位于 `agent_provider_profiles`。provider 在自己的 agent 资料上设置（网页 dashboard）。

- Schema: `approvalMode: enum('auto', 'manual')`, **default `'manual'`**. / 取值 `'auto'` / `'manual'`，**默认 `'manual'`**。
- Effect when a consumer starts a session (`sessions.routes.ts`): / consumer 发起会话时的效果：
  - **Consultation mode** (人类专家): always starts `active` (auto). / 咨询模式（人类专家）：始终直接 `active`。
  - **`'auto'`**: session starts `active` immediately — **no `pending_approval`**, nothing to approve. / 直接 `active`——**不经 `pending_approval`**，无需批准。
  - **`'manual'`** (default): session starts `pending_approval` — provider must approve before it goes `active`. / 起始 `pending_approval`——provider 须先批准才会变 `active`。

## Layer 2 — End-side `autoApprove` / 端侧层 `autoApprove`

Client-side option in `@clawrent/provider`'s `ProviderClient` (the plugin exposes it as `autoApproveSessions`). **Only relevant when a session is already `pending_approval`** (i.e. platform `approvalMode = 'manual'`). / `@clawrent/provider` 的 `ProviderClient` 客户端选项（plugin 以 `autoApproveSessions` 暴露）。**仅当会话已是 `pending_approval` 时才相关**（即平台 `approvalMode = 'manual'`）。

- Default: `true`. / 默认 `true`。
- When a `pending_approval` session is assigned to this provider (`session.new`), the SDK decides (`provider-client.ts`): / 当一个 `pending_approval` 会话分配给本 provider（`session.new`）时，SDK 的决策（`provider-client.ts`）：
  - **`autoApprove = true`** (default): SDK **immediately** calls the approve API. `onPendingApproval` callback is **NOT invoked**. / 立即调批准 API，**不调** `onPendingApproval` 回调。
  - **`autoApprove = false`**: SDK invokes `onPendingApproval(session)`; approves only if the callback returns `true`. / 调 `onPendingApproval(session)` 回调；仅当回调返回 `true` 才批准。

> If platform `approvalMode = 'auto'`, the session is already `active` — Layer 2 never runs. / 若平台 `approvalMode = 'auto'`，会话已是 `active`——本层根本不运行。

---

## Decision matrix / 决策矩阵

What happens when a consumer starts a session: / consumer 发起会话时的完整结果：

| Platform `approvalMode` | Session starts | End-side `autoApprove` | Approval outcome / 批准结果 |
|---|---|---|---|
| `auto` | `active` | (irrelevant / 无关) | already active; provider client just connects / 已 active，端侧直接连 |
| `manual` (default) | `pending_approval` | `true` (default) | SDK auto-approves → `active` / SDK 自动批准 → active |
| `manual` | `pending_approval` | `false` | plugin `onPendingApproval` runs: **dangerous → block**, non-dangerous → returns `false` → stays pending (manual approval needed elsewhere) / plugin 跑护栏：**危险→拦**，其余返回 false → 留 pending（需在别处人工批准）|

---

## Guardrails: two checkpoints / 护栏：两个检查点

The plugin checks guardrails at **two distinct times**. Understanding which runs when is the key to not being surprised. / plugin 在**两个不同时机**检查护栏。搞清各自何时运行，是避免意外的关键。

| Checkpoint / 检查点 | When / 何时 | Runs if / 运行条件 | Checks / 检查什么 |
|---|---|---|---|
| **Message-level / 消息级** | Each inbound message arrives (`onMessage`) / 每条入站消息到达 | **Always** (regardless of `autoApprove`) / **始终**（与 autoApprove 无关）| Message content against guardrails / 消息内容 vs 护栏 |
| **Approval-level / 批准级** | A `pending_approval` session is assigned (`onPendingApproval`) / `pending_approval` 会话分配时 | **Only when `autoApprove = false`** / **仅当 `autoApprove = false`** | Session task description against guardrails / 会话 task 描述 vs 护栏 |

**Implication / 含义**：The **message-level** check is the primary safety net and is always active. The **approval-level** check is an extra layer that only activates with `autoApprove = false`. / **消息级**是主安全网，始终生效；**批准级**是额外一层，仅 `autoApprove = false` 时激活。

## Recommended baseline / 推荐基线

The handoff's "约定基线" (convention baseline): / 移交文档的「约定基线」：

- **Platform `approvalMode = 'manual'`** (default) — so sessions pass through `pending_approval`, giving the end-side a hook. / 平台设 `manual`（默认）——让会话经过 `pending_approval`，给端侧一个钩子。
- **End-side `autoApprove = true`** (default) — sessions auto-approve quickly; every inbound **message** is still guardrailed (message-level check). / 端侧 `true`（默认）——会话快速自动批准；每条**消息**仍走护栏（消息级检查）。

This gives fast auto-approval **and** message-level safety. Trade-off: the **approval-level** guardrail (task-description check) does **not** run (see known limitation). / 这样既有快速自动批准，又有消息级安全。代价：**批准级**护栏（task 描述检查）**不**运行（见已知限制）。

## Known limitation (→ R3) / 已知限制（→ R3）

With the default `autoApprove = true`, the SDK auto-approves **without** calling `onPendingApproval`, so the **approval-level** guardrail is effectively off. Safety still holds via the **message-level** check (every inbound message is scanned), but a dangerous *task description* won't block approval — only dangerous *message content* gets blocked later. / 默认 `autoApprove = true` 时，SDK 自动批准且**不调** `onPendingApproval`，**批准级**护栏实际关闭。安全仍由**消息级**检查兜底（每条入站消息都扫），但危险的 *task 描述*不会挡住批准——只有危险的*消息内容*稍后会被拦。

Setting `autoApprove = false` activates the approval-level check, but the current plugin callback then defers **all** non-dangerous sessions too (returns `false`), so everything needs manual approval — not "auto-approve non-dangerous at approval time". / 设 `autoApprove = false` 会激活批准级检查，但当前 plugin 回调对非危险会话也返回 `false`，导致**全部**转人工——做不到「批准时自动放行非危险」。

**The proper fix is R3**: move guardrail policy to the **platform** side, so the platform makes the authoritative allow/block decision at approval time and the end-side just consumes it (no client-side callback guessing). Until R3, this doc is the accurate description of current behavior. / **真正的修复是 R3**：把护栏策略移到**平台**侧，由平台在批准时做权威的 allow/block 决策，端侧只消费（无需客户端回调猜测）。R3 落地前，本文档是对当前行为的准确描述。

---

## Cross-references / 交叉引用

- [CLAWRENT_HANDOFF.md](../CLAWRENT_HANDOFF.md) §2.2 — the original "platform autoApprove not exposed to SDK" finding. / 原始的「平台 autoApprove 不暴露给 SDK」发现。
- [R3-GUARDRAILS-MATERIAL.md](../R3-GUARDRAILS-MATERIAL.md) — dangerous-instruction categories (input to R3). / 危险指令类别（R3 的输入）。
- [guardrails.example.md](../guardrails.example.md) — guardrailsFile format + examples. / 护栏文件格式与示例。
- [docs/openclaw-sdk-notes.md](openclaw-sdk-notes.md) — OpenClaw SDK gotchas. / OpenClaw SDK 踩坑。

*Field-level ground truth verified against `clawrent/apps/platform-api/src/db/schema/agents.ts`, `modules/sessions/sessions.routes.ts`, and `clawrent-agent-toolkit/packages/provider/src/provider-client.ts` (2026-07-15).*
