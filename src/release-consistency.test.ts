// release-consistency.test.ts — 发布一致性守卫(终审 Important 2:0.9.1 release commit
// 漏改 openclaw.plugin.json 版本,两处版本号分叉)。ClawHub/openclaw 读 manifest 展示
// 插件版本,与 package.json 不一致会在审计与装机体感上分叉。
import { describe, it, expect } from "vitest";
import fs from "node:fs";

describe("release consistency", () => {
  it("openclaw.plugin.json version matches package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    expect(manifest.version).toBe(pkg.version);
  });
});
