import { describe, it, expect } from "vitest";
import { checkGuardrails, prefilter } from "./guardrails.js";

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
