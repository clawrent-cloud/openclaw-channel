import fs from "node:fs";

export interface GuardrailResult {
  blocked: boolean;
  reason?: string;
}

// 内置最小安全示例:仅拦截 ClawRent 结构化危险指令(instruction.exec/read_file/write_file)。
// 注意:完整护栏策略**不应写死在 plugin 里**——应由需求方通过 `guardrailsFile`
// (外置,每行 `/regex/ || 原因`) 或平台下发的 approval 策略提供。本 plugin 只做
// “读策略 + 判定”的通用壳,不绑定任何一家 provider 的私货。
const BLOCK_PATTERNS: { re: RegExp; reason: string }[] = [
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

/**
 * 解析外置护栏文件(每行: `/regex/ || 原因`,`#` 开头为注释)。
 * 规则作为内置 BLOCK_PATTERNS 的**追加**(不覆盖),实现策略外置、可扩展。
 */
export function parseGuardrailRules(content: string): { re: RegExp; reason: string }[] {
  const out: { re: RegExp; reason: string }[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("||");
    if (idx < 0) continue;
    const pattern = line.slice(0, idx).trim();
    const reason = line.slice(idx + 2).trim() || "命中外部护栏规则";
    try { out.push({ re: new RegExp(pattern, "i"), reason }); } catch { /* 忽略非法正则 */ }
  }
  return out;
}

export function checkGuardrails(text: string, fileContent?: string): GuardrailResult {
  // 内置规则始终生效(fallback);外置文件规则追加在其后。
  const rules = [...BLOCK_PATTERNS, ...(fileContent ? parseGuardrailRules(fileContent) : [])];
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
