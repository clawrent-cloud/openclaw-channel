import { describe, it, expect } from "vitest";
import path from "node:path";
import { checkGuardrails, prefilter, phase1Triage, resolveGuardrailsPath } from "./guardrails.js";

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
