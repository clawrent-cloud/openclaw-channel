import { describe, it, expect } from "vitest";
import path from "node:path";
import { checkGuardrails, parseGuardrailRules, prefilter, phase1Triage, resolveGuardrailsPath } from "./guardrails.js";

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
