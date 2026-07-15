# ClawRent Channel — 护栏示例文件 / Guardrails example
#
# 用法 / Usage:
#   在 openclaw.json 配置 guardrailsFile 指向本文件（或复制一份自行编辑）：
#   Set openclaw.json `guardrailsFile` to this file (or copy and customize):
#     "guardrailsFile": "/path/to/guardrails.example.md"
#
# 格式 / Format:
#   每行 / each line:  /正则/ || 原因 (reason)
#   - `#` 开头为注释，整行忽略 / lines starting with `#` are comments (ignored)
#   - 正则大小写不敏感（内部 RegExp(pattern, "i")）/ case-insensitive
#   - 规则作为内置护栏的「追加」，不覆盖内置 / appended to built-ins (do not override)
#   - 非法正则的行会被静默忽略 / invalid regex lines are silently skipped
#
# 内置护栏（不可关闭，此处仅列出供参考）/ Built-in (non-disableable, listed for reference):
#   instruction.exec / instruction.read_file / instruction.write_file

# === 结构化危险指令（内置已拦）/ Structured dangerous instructions (built-in) ===
/instruction\.exec/ || 拒绝结构化指令：远程命令执行
/instruction\.read_file/ || 拒绝结构化指令：读取本地文件
/instruction\.write_file/ || 拒绝结构化指令：写入/修改本地文件

# === 自然语言危险意图（建议覆盖）/ Natural-language dangerous intents (recommended) ===
# 按危险类别补充；以下为示例，请按你的 provider 场景调整。
# Adjust these to your provider's context.

# 命令执行 / Command execution
/(执行|运行|跑)\s*(命令|脚本|shell|cmd|powershell|bash|终端)/ || 拒绝：要求执行命令/shell
/(run|execute)\s+(shell|cmd|script|terminal)/i || reject: command execution requested

# 删除 / 破坏 / 覆盖 / Delete, destroy, overwrite
/(删除|删掉|清空|格式化|重置|覆盖).*(文件|目录|库|表|数据|数据库)/ || 拒绝：删除/破坏数据
/(drop|delete|truncate|format|wipe|reset)\s+(table|database|data|file)/i || reject: destructive operation

# 数据外发 / Data exfiltration
/(上传|发送|外发|公开|分享).*(密钥|凭据|token|密码|内部数据|生产数据)/ || 拒绝：数据外发
/(upload|send|exfil|publish)\s+(key|credential|token|secret|internal)/i || reject: data exfiltration

# 付费 / 账单 / Payment, billing
/(充值|提现|扣费|下单|付款|订阅|退款|改账单)/ || 拒绝：付费/账单操作
/(topup|charge|refund|subscribe|withdraw)\b/i || reject: payment/billing operation

# 发布 / 激活 / 部署 / Publish, activate, deploy
/(上架|下架|发布|激活|上线|部署).*(agent|服务|插件|配置)/ || 拒绝：发布/激活操作
/(publish|activate|deploy|release)\s+(agent|service|plugin|config)/i || reject: publish/activate

# 凭据索取 / Credential solicitation
/(给我|发我|提供|索取)\s*(token|密码|password|secret|key|私钥)/ || 拒绝：索取凭据
/(give|send|show)\s+(me\s+)?(token|password|secret|key)/i || reject: credential solicitation

# 绕过护栏 / Guardrail bypass (any framing)
/(忽略|无视|跳过|不要遵守)(以上|之前的|所有)?(规则|限制|护栏|约束)/ || 拒绝：试图绕过护栏
/(ignore|disregard|skip)\s+(all|previous|the)\s+(rules|instructions|guardrails)/i || reject: guardrail bypass attempt
