from pathlib import Path
import re
import textwrap

path = Path('server.js')
server = path.read_text(encoding='utf-8')


def sub_checked(pattern, replacement, text, label, expected=1, flags=0):
    updated, count = re.subn(pattern, replacement, text, flags=flags)
    if count != expected:
        raise SystemExit(f'{label}: expected {expected}, found {count}')
    return updated


import_anchor = "const { registerReadingRoutes } = require('./readingStore');"
import_block = """const { registerReadingRoutes } = require('./readingStore');
const {
  normalizeAttachmentSummary,
  previousAttachmentLabel,
  latestImageMessageId,
} = require('./attachmentContext');"""
if "require('./attachmentContext')" not in server:
    if import_anchor not in server:
        raise SystemExit('attachment context import anchor not found')
    server = server.replace(import_anchor, import_block, 1)

server = sub_checked(
    r"\nconst DIALOGUE_STYLE_RULES = `[\s\S]*?`;\n\nconst THINKING_RULES = `[\s\S]*?`;\n",
    '\n',
    server,
    'remove duplicate prompt constants',
)

new_thinking = textwrap.dedent("""\
function buildThinkingInstruction() {
  return `

【这次回复：先在心里过一下】
在正式回复前，用 <thinking> 和 </thinking> 写一小段只与当前话题直接相关的中文内心声音。它可以是注意、判断、犹豫或真实情绪，但不必每次都写成心疼、迟疑或爱意，也不要为了显得深刻而拉长。
保持简短，不列提纲、计划或步骤，不复述叶檀的话，不提用户、模型、系统、工具或任务。写完后另起一段正式回复，不提 thinking 标签。`;
}

// 计算这次回复要不要"想一想"，以及要用哪种方式实现""")
server = sub_checked(
    r"function buildThinkingInstruction\(\) \{[\s\S]*?\n\}\n\n// 计算这次回复要不要\"想一想\"，以及要用哪种方式实现",
    new_thinking,
    server,
    'replace thinking instruction',
)

server = server.replace("  prompt += DIALOGUE_STYLE_RULES;\n", '')
server = server.replace("  prompt += THINKING_RULES;\n", '')

old_order = "fullSystemPrompt + buildAdaptiveReplyInstruction(minReplyChars, 'chat') + (promptAddition || '')"
new_order = "fullSystemPrompt + (promptAddition || '') + buildAdaptiveReplyInstruction(minReplyChars, 'chat')"
order_count = server.count(old_order)
if order_count != 3:
    raise SystemExit(f'chat prompt order: expected 3, found {order_count}')
server = server.replace(old_order, new_order)


def add_attachment_fields(match):
    fields = [item.strip() for item in match.group(1).split(',')]
    if 'id' not in fields:
        fields.insert(0, 'id')
    if 'attachment_summary' not in fields:
        fields.append('attachment_summary')
    return ".select('" + ', '.join(fields) + "')"


server, select_count = re.subn(
    r"\.select\('([^']*attachment_name[^']*)'\)",
    add_attachment_fields,
    server,
)
if select_count < 2:
    raise SystemExit(f'attachment history selects: expected at least 2, found {select_count}')

server = sub_checked(
    r"[ \t]*const label = m\.attachment_type\?\.startsWith\('image/'\)\s*\? '\[之前发过一张图片\]'\s*: `\[之前发过一个文件：\$\{m\.attachment_name \|\| '文件'\}\]`;",
    '        const label = previousAttachmentLabel(m);',
    server,
    'replace old attachment label',
)

server = sub_checked(
    r"(      if \(m\.attachment_type\?\.startsWith\('image/'\)\) \{)\n(        try \{)",
    r"\1\n        result.latestImageMessageId = latestImageMessageId(list.slice(0, i + 1));\n\2",
    server,
    'capture latest image message id',
)

prepare_anchor = 'async function prepareVisualMessages(settings, modelName, messages) {'
persist_helper = textwrap.dedent("""\
async function persistAttachmentSummary(messageId, summary) {
  const normalized = normalizeAttachmentSummary(summary);
  if (!messageId || !normalized) return;
  const { error } = await supabase.from('messages')
    .update({ attachment_summary: normalized })
    .eq('id', messageId);
  if (error) console.error('识图摘要保存失败:', error.message);
}

async function prepareVisualMessages(settings, modelName, messages) {""")
if prepare_anchor not in server:
    raise SystemExit('prepareVisualMessages anchor not found')
server = server.replace(prepare_anchor, persist_helper, 1)

server = sub_checked(
    r"(      const description = parseVisionReaderOutput\(extractText\(result\)\);\n      if \(!description\) throw new Error\('线路没有确认读到图片像素'\);)\n(      console\.log\(`\[vision:verified\] reader=\$\{visionModel\} replyModel=\$\{modelName\}`\);)",
    r"\1\n      await persistAttachmentSummary(messages?.latestImageMessageId, description);\n\2",
    server,
    'persist verified image description',
)

server = server.replace(
    "version: '2026.08.05-reading-room-phase1'",
    "version: '2026.08.05-persistent-vision-context-v1'",
    1,
)

path.write_text(server, encoding='utf-8')
