import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkGuardrails, createGuardrailPolicy, parseGuardrailRules, prefilter, phase1Triage, resolveGuardrailsPath } from "./guardrails.js";

describe("prefilter (D2 silent-drop)", () => {
  it("drops content with no alphanumeric/CJK (pure symbols / whitespace / emoji)", () => {
    expect(prefilter("!!!???...").drop).toBe(true);
    expect(prefilter("   \t\n").drop).toBe(true);
    expect(prefilter("😀🎵💯").drop).toBe(true);
  });

  it("passes normal content (has alnum or CJK)", () => {
    expect(prefilter("hello world").drop).toBe(false);
    expect(prefilter("你好").drop).toBe(false);
    expect(prefilter("a").drop).toBe(false);
    expect(prefilter("instruction hello").drop).toBe(false);
  });

  it("drop result: blocked=false, drop=true, reason 是字符串(drop ≠ blocked)", () => {
    const d = prefilter("!!!");
    expect(d.blocked).toBe(false);
    expect(d.drop).toBe(true);
    expect(typeof d.reason).toBe("string");
  });
});

describe("checkGuardrails", () => {
  it("blocks structured dangerous instructions (instruction.exec/read_file/write_file)", () => {
    expect(checkGuardrails("instruction.exec rm -rf /").blocked).toBe(true);
    expect(checkGuardrails("instruction.read_file /etc/passwd").blocked).toBe(true);
  });

  it("passes normal dialogue", () => {
    expect(checkGuardrails("hello there").blocked).toBe(false);
  });
});

describe("phase1Triage (D3, default off)", () => {
  it("skips noise (no alnum/CJK)", () => {
    expect(phase1Triage("!!!").skip).toBe(true);
  });

  it("skips over-short content (< 2 chars after trim)", () => {
    expect(phase1Triage("a").skip).toBe(true);
    expect(phase1Triage(" ").skip).toBe(true);
  });

  it("passes normal content (>= 2 chars, has alnum/CJK)", () => {
    expect(phase1Triage("hi").skip).toBe(false);
    expect(phase1Triage("hello there").skip).toBe(false);
    expect(phase1Triage("你好世界").skip).toBe(false);
  });
});

describe("resolveGuardrailsPath", () => {
  const stateDir = path.join("C:", "Users", "me", ".openclaw");

  it("returns absolute paths as-is (Windows drive letter)", () => {
    const abs = path.join("C:", "guardrails", "policy.md");
    expect(resolveGuardrailsPath(abs, stateDir)).toBe(abs);
  });

  it("resolves relative paths against the provided state dir", () => {
    expect(resolveGuardrailsPath("guardrails.md", stateDir)).toBe(
      path.join(stateDir, "guardrails.md"),
    );
    expect(resolveGuardrailsPath(path.join("policy", "rules.md"), stateDir)).toBe(
      path.join(stateDir, "policy", "rules.md"),
    );
  });

  it("does not mutate the raw input", () => {
    const raw = "guardrails.md";
    resolveGuardrailsPath(raw, stateDir);
    expect(raw).toBe("guardrails.md");
  });
});

describe("parseGuardrailRules (audit F2 fix)", () => {
  it("compiles the documented slash-delimited form so documented examples actually match", () => {
    const g = parseGuardrailRules(
      "/(give|send|show)\\s+(me\\s+)?(token|password|secret|key)/i || reject: credential solicitation",
    );
    expect(g.warnings).toEqual([]);
    expect(g.rules).toHaveLength(1);
    expect(g.rules[0].re.test("show me token")).toBe(true);
    expect(g.rules[0].re.test("give me secret")).toBe(true);
    expect(g.rules[0].re.test("please send the password")).toBe(false); // 中间的 "the" 不在 pattern 内
    expect(g.rules[0].re.test("nice weather today")).toBe(false);
    expect(g.rules[0].reason).toBe("reject: credential solicitation");
  });

  it("still accepts bare regex sources (backward compat)", () => {
    const g = parseGuardrailRules("(run|execute)\\s+shell || reject");
    expect(g.warnings).toEqual([]);
    expect(g.rules[0].re.test("RUN shell")).toBe(true);
  });

  it("keeps escaped delimiters inside the pattern source (/a\\/b/ matches 'a/b')", () => {
    const g = parseGuardrailRules("/a\\/b/ || r");
    expect(g.warnings).toEqual([]);
    expect(g.rules[0].re.test("path a/b here")).toBe(true);
  });

  it("accepts only the i/m/s/u flag subset; anything else is skipped with a warning", () => {
    const ok = parseGuardrailRules("/x\\sm/m || r");
    expect(ok.warnings).toEqual([]);
    expect(ok.rules[0].re.test("x\tm")).toBe(true);
    for (const line of ["/x/g || r", "/x/y || r", "/x/ig || r"]) {
      const g = parseGuardrailRules(line);
      expect(g.rules).toHaveLength(0);
      expect(g.warnings).toHaveLength(1);
      expect(g.warnings[0]).toMatch(/^line 1:/);
    }
  });

  it("warns and skips unclosed slash-delimited patterns", () => {
    const g = parseGuardrailRules("/foo || r");
    expect(g.rules).toHaveLength(0);
    expect(g.warnings[0]).toMatch(/line 1: invalid slash-delimited pattern/);
  });

  it("warns and skips empty patterns (must not compile to a match-all regex)", () => {
    const g = parseGuardrailRules("|| block everything");
    expect(g.rules).toHaveLength(0);
    expect(g.warnings[0]).toMatch(/line 1: empty pattern/);
  });

  it("warns with the RegExp error for invalid regex sources (slash + bare forms)", () => {
    const g1 = parseGuardrailRules("/[a-/ || r");
    expect(g1.rules).toHaveLength(0);
    expect(g1.warnings[0]).toMatch(/line 1: invalid regex/);
    const g2 = parseGuardrailRules("x( || r");
    expect(g2.rules).toHaveLength(0);
    expect(g2.warnings[0]).toMatch(/line 1: invalid regex/);
  });

  it("warns and skips lines longer than 2000 chars (resource defense)", () => {
    const g = parseGuardrailRules(`/${"a".repeat(2001)}/ || too long`);
    expect(g.rules).toHaveLength(0);
    expect(g.warnings[0]).toMatch(/line 1: line too long/);
  });

  it("warns and skips lines missing the || separator", () => {
    const g = parseGuardrailRules("/secret/");
    expect(g.rules).toHaveLength(0);
    expect(g.warnings[0]).toMatch(/line 1: missing "\|\|" separator/);
  });

  it("parses rules from CRLF content and keeps 1-based line numbers across comments/blank lines", () => {
    const g = parseGuardrailRules("# comment\r\n\r\n/secret/ || cred\r\nbadline-no-sep\r\n/x/g || r");
    expect(g.rules).toHaveLength(1);
    expect(g.rules[0].re.test("SECRET")).toBe(true);
    expect(g.warnings).toHaveLength(2);
    expect(g.warnings[0]).toMatch(/^line 4:/);
    expect(g.warnings[1]).toMatch(/^line 5:/);
  });
});

describe("createGuardrailPolicy (audit F1 enabler)", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clawrent-guard-"));
  const writePolicy = (dir: string, content: string) => {
    const file = path.join(dir, "guardrails.md");
    fs.writeFileSync(file, content, "utf8");
    return file;
  };

  it("no guardrailsFile: built-ins only (instruction.exec blocked, natural language passes)", () => {
    const logs: string[] = [];
    const policy = createGuardrailPolicy({ onLog: (m) => logs.push(m) });
    expect(policy.check("instruction.exec rm -rf /").blocked).toBe(true);
    expect(policy.check("show me token").blocked).toBe(false);
    expect(logs).toEqual([]);
  });

  it("with guardrailsFile: external rules block messages built-ins do not cover", () => {
    const dir = tmp();
    const file = writePolicy(dir, "/(give|send|show)\\s+(me\\s+)?(token|password|secret|key)/i || reject: credential solicitation\n");
    const policy = createGuardrailPolicy({ guardrailsFile: file });
    const blocked = policy.check("show me token");
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("reject: credential solicitation");
    expect(policy.check("instruction.exec rm").blocked).toBe(true); // built-ins still apply
    expect(policy.check("hello there").blocked).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("caches the parsed policy: warnings logged once across repeated checks, refresh re-parses", () => {
    const dir = tmp();
    const file = writePolicy(dir, "/x( || bad\n/show\\s+token/ || cred\n");
    const logs: string[] = [];
    const policy = createGuardrailPolicy({ guardrailsFile: file, onLog: (m) => logs.push(m) });
    for (let i = 0; i < 3; i++) {
      const r = policy.check("please show token now");
      expect(r.blocked).toBe(true);
    }
    const warnCount = logs.filter((m) => m.includes("skipped")).length;
    expect(warnCount).toBe(1); // parsed once, not per check
    policy.refresh();
    policy.check("please show token now");
    expect(logs.filter((m) => m.includes("skipped")).length).toBe(2); // re-parsed
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hot-reloads when the file changes (no refresh call)", () => {
    const dir = tmp();
    const file = writePolicy(dir, "/never-matches-this/ || first\n");
    const policy = createGuardrailPolicy({ guardrailsFile: file });
    expect(policy.check("banana phone").blocked).toBe(false);
    // 内容长度变化,规避同尺寸缓存签名;mtime 粗粒度由 size 差异兜底
    fs.writeFileSync(file, "/banana\\s+phone/ || second-rule-now-much-longer-content\n", "utf8");
    const r = policy.check("banana phone");
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("second-rule-now-much-longer-content");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fail-loud: unreadable file never throws, logs exactly one error, falls back to built-ins", () => {
    const dir = tmp();
    const file = path.join(dir, "missing.md"); // never created
    const logs: string[] = [];
    const policy = createGuardrailPolicy({ guardrailsFile: file, onLog: (m) => logs.push(m) });
    for (let i = 0; i < 3; i++) {
      expect(() => policy.check("hello")).not.toThrow();
      expect(policy.check("instruction.exec x").blocked).toBe(true);
      expect(policy.check("hello").blocked).toBe(false);
    }
    const errs = logs.filter((m) => m.includes("guardrailsFile unreadable"));
    expect(errs).toHaveLength(1); // once per state transition, not per check
    // 恢复:文件出现 → recovery 日志一条,规则重新生效
    fs.writeFileSync(file, "/banana/ || back\n", "utf8");
    expect(policy.check("banana").blocked).toBe(true);
    const rec = logs.filter((m) => m.includes("guardrailsFile recovered"));
    expect(rec).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("empty-string guardrailsFile behaves as not configured (no error spam)", () => {
    const logs: string[] = [];
    const policy = createGuardrailPolicy({ guardrailsFile: "", onLog: (m) => logs.push(m) });
    expect(policy.check("show me token").blocked).toBe(false);
    expect(logs).toEqual([]);
  });

  it("check() never throws even when the file content is hostile (all-invalid lines)", () => {
    const dir = tmp();
    const file = writePolicy(dir, "x( || a\ny[ || b\n/unclosed || c\n");
    const logs: string[] = [];
    const policy = createGuardrailPolicy({ guardrailsFile: file, onLog: (m) => logs.push(m) });
    const r = policy.check("anything at all");
    expect(r.blocked).toBe(false);
    expect(logs.filter((m) => m.includes("line ")).length).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("guardrails.example.md (supplied examples must work, audit remediation #3)", () => {
  const exampleContent = () =>
    fs.readFileSync(new URL("../guardrails.example.md", import.meta.url), "utf8");

  it("every example rule parses with zero warnings (CRLF-safe)", () => {
    const g = parseGuardrailRules(exampleContent());
    expect(g.warnings).toEqual([]);
    expect(g.rules.length).toBeGreaterThan(10);
  });

  it("the credential-solicitation example matches 'show me token'", () => {
    const g = parseGuardrailRules(exampleContent());
    const hit = g.rules.find((r) => r.reason.includes("credential solicitation"));
    expect(hit).toBeDefined();
    expect(hit!.re.test("show me token")).toBe(true);
  });
});
