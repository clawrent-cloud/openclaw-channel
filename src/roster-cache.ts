// roster-cache.ts — 支柱 C(plugin 侧):会话级 participant 名单缓存。
import { sanitizeUntrustedText } from "./guardrails.js";
//
// 数据源(经 ProviderClient 两条通道到达,均在此归一):
//   - onMessage(session:message):system.roster(connect 快照,含 ownerName)、
//     session.participant_paused/resumed/ended/removed(控制帧广播)
//   - 'session:presence' 事件:system.participant_joined/left(增量)
//
// 纯函数、无副作用:provider.ts 持有 Map<sessionId, RosterEntry[]>,每帧调用
// applyRosterFrame 维护;缓存经 ChannelStructuredContext 注入(0.9.3 起不进前导),
// agent 据此知道"会话里都有谁、谁从属谁";display/ownerName 入缓存即清洗。
//
// 生命周期边界(终审 F5,接受):本 agent 被 pause(4020,SDK 停止重连)期间会话被
// end,无连接可投递 4021 → onSessionEnded 不触发,该会话条目留存至插件重启
// (每条数百字节,有界,不清算)。

export interface RosterEntry {
  participantId: string;
  type: string; // 'human' | 'agent'
  side: string; // 'provider' | 'consumer'
  display: string | null;
  agentId?: string | null;
  ownerName?: string | null;
  /** 在场状态(presence 增量维护;快照条目默认 active)。 */
  status?: "active" | "paused";
}

export type RosterCache = Map<string, RosterEntry[]>;

type FramePayload = unknown;

function payloadOf(payload: FramePayload): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

/** system.roster 快照:整体替换该会话条目(重连后以服务端最新名单为准)。 */
function applySnapshot(cache: RosterCache, sessionId: string, payload: FramePayload): void {
  const raw = payloadOf(payload)["participants"];
  if (!Array.isArray(raw)) return;
  const entries: RosterEntry[] = [];
  for (const item of raw) {
    const e = normalizeEntry(item);
    if (e) entries.push(e);
  }
  cache.set(sessionId, entries);
}

/** 单个 participant 载荷(system.roster 条目 / participant_joined.participant)→ RosterEntry。
 *  0.9.3(minor sweep):display/ownerName 入缓存即过 sanitizeUntrustedText —— 结构化通道
 *  交付的就是这份缓存,压平在入口做,下游(检查串/结构化 payload)无需各自设防。 */
function normalizeEntry(item: unknown): RosterEntry | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const participantId = typeof o["participantId"] === "string" ? o["participantId"] : null;
  if (!participantId) return null;
  const type = typeof o["type"] === "string" ? o["type"] : String(o["participantType"] ?? "");
  const display = typeof o["display"] === "string" ? o["display"] : null;
  return {
    participantId,
    type,
    side: typeof o["side"] === "string" ? o["side"] : "",
    display: display ? sanitizeUntrustedText(display, 128) : null,
    agentId: typeof o["agentId"] === "string" ? o["agentId"] : null,
    ownerName:
      typeof o["ownerName"] === "string" && o["ownerName"] ? sanitizeUntrustedText(o["ownerName"], 64) : null,
  };
}

/** system.participant_joined:按 participantId upsert(重连抖动幂等)。 */
function applyJoined(cache: RosterCache, sessionId: string, payload: FramePayload): void {
  const entry = normalizeEntry(payloadOf(payload)["participant"]);
  if (!entry) return;
  const list = cache.get(sessionId) ?? [];
  const idx = list.findIndex((e) => e.participantId === entry.participantId);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  cache.set(sessionId, list);
}

function findByPayloadId(cache: RosterCache, sessionId: string, payload: FramePayload): { list: RosterEntry[]; index: number } | null {
  const pid = payloadOf(payload)["participantId"];
  if (typeof pid !== "string") return null;
  const list = cache.get(sessionId);
  if (!list) return null;
  const index = list.findIndex((e) => e.participantId === pid);
  return index < 0 ? null : { list, index };
}

/** system.participant_left / session.participant_ended / session.participant_removed:移除。 */
function applyGone(cache: RosterCache, sessionId: string, payload: FramePayload): void {
  const hit = findByPayloadId(cache, sessionId, payload);
  if (!hit) return;
  hit.list.splice(hit.index, 1);
  cache.set(sessionId, hit.list);
}

/** session.participant_paused(→paused) / resumed(→active):在场状态标记。
 *
 * 生产可达的两种序列(2026-11-18 UAT 实证):
 *  - 在线被 pause:paused 帧后紧跟其 socket close 的 left 帧 → 条目最终移除
 *    (paused 标记只短暂存活;"不在场"语义,与被暂停者无法发言一致)。
 *  - 离线被 pause(无 socket 可关):只有 paused 帧,无 left → 条目保留并标记
 *    已暂停;resume 后标记回 active,agent 重连时 joined 增量补全。 */
function applyStatus(cache: RosterCache, sessionId: string, payload: FramePayload, status: "active" | "paused"): void {
  const hit = findByPayloadId(cache, sessionId, payload);
  if (!hit) return;
  hit.list[hit.index] = { ...hit.list[hit.index], status };
  cache.set(sessionId, hit.list);
}

/**
 * 单入口:按帧类型维护缓存;无关类型(dialogue.* / system.heartbeat_ack / ...)no-op。
 * provider.ts 在 onMessage 与 'session:presence' 两处调用同一函数。
 */
export function applyRosterFrame(
  cache: RosterCache,
  sessionId: string,
  type: string,
  payload: FramePayload,
): void {
  switch (type) {
    case "system.roster":
      return applySnapshot(cache, sessionId, payload);
    case "system.participant_joined":
      return applyJoined(cache, sessionId, payload);
    case "system.participant_left":
    case "session.participant_ended":
    case "session.participant_removed":
      return applyGone(cache, sessionId, payload);
    case "session.participant_paused":
      return applyStatus(cache, sessionId, payload, "paused");
    case "session.participant_resumed":
      return applyStatus(cache, sessionId, payload, "active");
    default:
      return; // 与名单无关的帧,不动缓存
  }
}

const SIDE_LABEL: Record<string, string> = { provider: "供方", consumer: "消费者" };

/**
 * 名单 → 一行紧凑文案(如 `Alice(消费者) · Pink Bot(供方·Zhzago)`)。
 * 0.9.3 起不进 agent 前导,仅作为元数据策略的**检查串**(命中即整名单从结构化通道剥离);
 * display 缺失回退 participantId 前 8 位;agent 带 ownerName 时以 `·` 标从属;
 * paused 条目追加 `·已暂停`。空名单返回空字符串。
 */
export function formatRosterLine(entries: RosterEntry[]): string {
  const parts = entries.map((e) => {
    const name = e.display && e.display.trim() ? e.display : e.participantId.slice(0, 8);
    const side = SIDE_LABEL[e.side] ?? e.side;
    const owner = e.type === "agent" && e.ownerName ? `·${e.ownerName}` : "";
    const paused = e.status === "paused" ? "·已暂停" : "";
    return `${name}(${side}${owner}${paused})`;
  });
  return parts.join(" · ");
}
