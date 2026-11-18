import fs from "node:fs";
import path from "node:path";

export interface GuardrailResult {
  blocked: boolean;
  /** D2: silent drop (no reply, no warning) — vs `blocked` which replies with a warning. */
  drop?: boolean;
  reason?: string;
}

// 内置最小安全示例:仅拦截 ClawRent 结构化危险指令(instruction.exec/read_file/write_file)。
// 注意:完整护栏策略**不应写死在 plugin 里**——应由需求方通过 `guardrailsFile`
// (外置,每行 `/regex/ || 原因`) 或平台下发的 approval 策略提供。本 plugin 只做
// “读策略 + 判定”的通用壳,不绑定任何一家 provider 的私货。
const BLOCK_PATTERNS: GuardrailRule[] = [
  // ClawRent 消息类型层面的危险指令(结构化 instruction.* 一律拦)
  { re: /instruction\.(exec|read_file|write_file)/i, reason: "拒绝结构化危险指令(exec/文件读写)" },
];

export function loadGuardrails(path?: string): string {
  if (!path) return "";
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Resolve a user-supplied guardrailsFile. Absolute → as-is; relative → against the
 *  OpenClaw state dir (~/.openclaw), never the gateway process CWD (System32 under
 *  the scheduled task). */
export function resolveGuardrailsPath(raw: string, stateDir: string): string {
  return path.isAbsolute(raw) ? raw : path.join(stateDir, raw);
}

export interface GuardrailRule {
  re: RegExp;
  reason: string;
}

export interface ParsedGuardrailFile {
  rules: GuardrailRule[];
  /** 解析告警(含 1-based 行号):非法/超长/缺分隔符的行被跳过时逐条给出,不再静默。 */
  warnings: string[];
}

const MAX_RULE_LINE_LENGTH = 2000;
/** 斜杠定界形式 `/source/flags`;贪婪回溯取最后一个「后随仅 flag 字符」的斜杠,`\/` 天然留在 source 中。 */
const SLASH_DELIMITED = /^\/([\s\S]*)\/([imsu]*)$/;

/**
 * 解析外置护栏文件。
 * 每行两种等价格式:`/regex/flags || 原因`(斜杠定界,flags 仅支持 i/m/s/u,大小写
 * 不敏感恒开)或裸正则源 `regex || 原因`;`#` 开头为注释,空行忽略。
 * 非法行(未闭合定界/白名单外 flag/非法正则/空 pattern/缺 `||`/超长)跳过并记入
 * warnings。规则作为内置 BLOCK_PATTERNS 的**追加**(不覆盖)。
 */
export function parseGuardrailRules(content: string): ParsedGuardrailFile {
  const rules: GuardrailRule[] = [];
  const warnings: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNo = i + 1;
    if (!line || line.startsWith("#")) continue;
    if (line.length > MAX_RULE_LINE_LENGTH) {
      warnings.push(`line ${lineNo}: line too long (>${MAX_RULE_LINE_LENGTH} chars), skipped: ${line.slice(0, 40)}`);
      continue;
    }
    const idx = line.indexOf("||");
    if (idx < 0) {
      warnings.push(`line ${lineNo}: missing "||" separator, skipped: ${line.slice(0, 40)}`);
      continue;
    }
    const pattern = line.slice(0, idx).trim();
    const reason = line.slice(idx + 2).trim() || "命中外部护栏规则";
    if (!pattern) {
      warnings.push(`line ${lineNo}: empty pattern, skipped`);
      continue;
    }
    let source = pattern;
    let flags = "";
    if (pattern.startsWith("/")) {
      const m = pattern.match(SLASH_DELIMITED);
      if (!m) {
        warnings.push(`line ${lineNo}: invalid slash-delimited pattern, skipped: ${pattern.slice(0, 40)}`);
        continue;
      }
      source = m[1];
      flags = m[2];
    }
    try {
      rules.push({ re: new RegExp(source, flags.includes("i") ? flags : flags + "i"), reason });
    } catch (e) {
      warnings.push(`line ${lineNo}: invalid regex (${e instanceof Error ? e.message : String(e)}), skipped`);
    }
  }
  return { rules, warnings };
}

export function checkGuardrails(text: string, fileContent?: string): GuardrailResult {
  // 内置规则始终生效(fallback);外置文件规则追加在其后。
  const rules: GuardrailRule[] = [
    ...BLOCK_PATTERNS,
    ...(fileContent ? parseGuardrailRules(fileContent).rules : []),
  ];
  for (const p of rules) {
    if (p.re.test(text)) {
      return {
        blocked: true,
        reason: `命中护栏拦截规则：${p.reason}。需人工介入，provider 不会自动执行。`,
      };
    }
  }
  return { blocked: false };
}

/**
 * D2 prefilter: silent-drop obvious garbage (no reply, no warning) BEFORE driving the
 * agent. Conservative — only drops content with no alphanumeric/CJK at all (pure
 * symbols/punctuation/whitespace beyond the empty-trim check). Legit messages pass.
 */
export function prefilter(text: string): GuardrailResult {
  if (!/[A-Za-z0-9一-鿿]/.test(text)) {
    return { blocked: false, drop: true, reason: "content has no alphanumeric/CJK — likely noise" };
  }
  return { blocked: false, drop: false };
}

/**
 * D3 phase-1 triage (default OFF, gated by `triageTwoPhase` config): cheap rule-based
 * pre-screen BEFORE the full guardrail + dispatch. Returns {skip} to silent-drop what's
 * clearly not worth a full turn. Conservative; twoPhase is off by default so this only
 * runs when explicitly enabled.
 */
export function phase1Triage(text: string): { skip: boolean; reason?: string } {
  const pre = prefilter(text);
  if (pre.drop) return { skip: true, reason: pre.reason };
  if (text.trim().length < 2) return { skip: true, reason: "content too short for a turn" };
  return { skip: false };
}
