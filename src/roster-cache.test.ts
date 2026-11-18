import { describe, expect, it } from "vitest";
import {
  applyRosterFrame,
  formatRosterForPreamble,
  type RosterCache,
  type RosterEntry,
} from "./roster-cache.js";

// 支柱 C(plugin 侧):把 system.roster / participant 增量维护成会话级缓存,
// 让 agent 上下文知道"会话里都有谁、谁从属谁"。

const SNAPSHOT: RosterEntry[] = [
  { participantId: "ph1", type: "human", side: "consumer", display: "Alice", agentId: null, ownerName: null },
  { participantId: "pa1", type: "agent", side: "provider", display: "Pink Bot", agentId: "ag1", ownerName: "Zhzago" },
];

function mk(): RosterCache {
  const cache: RosterCache = new Map();
  applyRosterFrame(cache, "s1", "system.roster", { participants: SNAPSHOT });
  return cache;
}

describe("applyRosterFrame — system.roster 快照", () => {
  it("快照替换该会话的全部条目(含 ownerName)", () => {
    const cache = mk();
    expect(cache.get("s1")).toEqual(SNAPSHOT);
  });

  it("第二次快照覆盖第一次(重连后名单以最新为准)", () => {
    const cache = mk();
    applyRosterFrame(cache, "s1", "system.roster", { participants: [SNAPSHOT[0]] });
    expect(cache.get("s1")).toHaveLength(1);
    expect(cache.get("s1")![0].participantId).toBe("ph1");
  });
});

describe("applyRosterFrame — participant 增量", () => {
  it("joined:新增条目,participantInfo 形状归一(type/display/ownerName)", () => {
    const cache = mk();
    applyRosterFrame(cache, "s1", "system.participant_joined", {
      participant: {
        participantId: "pa2", participantType: "agent", type: "agent", side: "provider",
        userId: null, agentId: "ag2", role: "member", display: "Ghost Bot", ownerName: null,
      },
    });
    const entry = cache.get("s1")!.find((e) => e.participantId === "pa2");
    expect(entry).toMatchObject({ display: "Ghost Bot", ownerName: null, side: "provider" });
  });

  it("joined:同 participantId 不重复(重连抖动幂等)", () => {
    const cache = mk();
    applyRosterFrame(cache, "s1", "system.participant_joined", {
      participant: { participantId: "pa1", type: "agent", side: "provider", display: "Pink Bot", agentId: "ag1", ownerName: "Zhzago" },
    });
    expect(cache.get("s1")!.filter((e) => e.participantId === "pa1")).toHaveLength(1);
  });

  it("joined:载荷缺 participantId → 忽略(防御畸形帧)", () => {
    const cache = mk();
    applyRosterFrame(cache, "s1", "system.participant_joined", { participant: { side: "provider" } });
    expect(cache.get("s1")).toHaveLength(2);
  });

  it("left:移除条目", () => {
    const cache = mk();
    applyRosterFrame(cache, "s1", "system.participant_left", { participantId: "pa1" });
    expect(cache.get("s1")!.some((e) => e.participantId === "pa1")).toBe(false);
  });

  it("paused → 标记 paused;resumed → 回 active(在场增量)", () => {
    const cache = mk();
    applyRosterFrame(cache, "s1", "session.participant_paused", { sessionId: "s1", participantId: "pa1" });
    expect(cache.get("s1")!.find((e) => e.participantId === "pa1")!.status).toBe("paused");
    applyRosterFrame(cache, "s1", "session.participant_resumed", { sessionId: "s1", participantId: "pa1" });
    expect(cache.get("s1")!.find((e) => e.participantId === "pa1")!.status).toBe("active");
  });

  it("ended/removed:移除条目", () => {
    const cache = mk();
    applyRosterFrame(cache, "s1", "session.participant_ended", { sessionId: "s1", participantId: "pa1" });
    applyRosterFrame(cache, "s1", "session.participant_removed", { sessionId: "s1", participantId: "ph1" });
    expect(cache.get("s1")).toHaveLength(0);
  });
});

describe("applyRosterFrame — 无关帧", () => {
  it("dialogue/未知类型 no-op,缓存不动", () => {
    const cache = mk();
    const before = JSON.stringify([...cache.get("s1")!]);
    applyRosterFrame(cache, "s1", "dialogue.message", { content: "hi" });
    applyRosterFrame(cache, "s1", "system.heartbeat_ack", {});
    expect(JSON.stringify([...cache.get("s1")!])).toBe(before);
  });
});

describe("formatRosterForPreamble — agent 前导文案", () => {
  it("渲染 display/阵营/归属/paused 状态", () => {
    const entries: RosterEntry[] = [
      ...SNAPSHOT,
      { participantId: "pa2", type: "agent", side: "provider", display: "Ghost Bot", agentId: "ag2", ownerName: null, status: "paused" },
    ];
    const text = formatRosterForPreamble(entries);
    expect(text).toContain("Alice(消费者)");
    expect(text).toContain("Pink Bot(供方·Zhzago)");
    expect(text).toContain("Ghost Bot(供方·已暂停)");
  });

  it("display 缺失回退 participantId 前 8 位;owner 缺失不加点", () => {
    const text = formatRosterForPreamble([
      { participantId: "abcdefgh1234", type: "agent", side: "provider", display: null, agentId: "ag9", ownerName: null },
    ]);
    expect(text).toContain("abcdefgh(供方)");
    expect(text).not.toContain("·)");
  });

  it("空名单 → 空字符串(不注入废行)", () => {
    expect(formatRosterForPreamble([])).toBe("");
  });
});
