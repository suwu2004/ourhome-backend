from pathlib import Path
import re
import textwrap

path = Path('server.js')
server = path.read_text(encoding='utf-8')


def sub_checked(pattern, replacement, text, label, expected=1, flags=0):
    updated, count = re.subn(pattern, lambda _match: replacement, text, flags=flags)
    if count != expected:
        raise SystemExit(f'{label}: expected {expected}, found {count}')
    return updated


attachment_import = """const {
  normalizeAttachmentSummary,
  previousAttachmentLabel,
  latestImageMessageId,
} = require('./attachmentContext');"""
thinking_import = """const {
  extractThinkingText,
  stripThinkingMarkup,
} = require('./thinkingSupport');"""
if "require('./thinkingSupport')" not in server:
    if attachment_import not in server:
        raise SystemExit('attachment import anchor not found')
    server = server.replace(attachment_import, f"{attachment_import}\n{thinking_import}", 1)

new_extract_text = textwrap.dedent("""\
function extractText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const anthropicText = blocks
    .filter(block => block?.type === 'text')
    .map(block => stripTextToolMarkup(stripThinkingMarkup(block?.text || '')))
    .filter(Boolean)
    .join(String.fromCharCode(10))
    .trim();
  if (anthropicText) return anthropicText;

  const openAiText = (Array.isArray(result?.choices) ? result.choices : [])
    .map(choice => choice?.message?.content || choice?.delta?.content || '')
    .map(text => stripTextToolMarkup(stripThinkingMarkup(text)))
    .filter(Boolean)
    .join(String.fromCharCode(10))
    .trim();
  if (openAiText) return openAiText;

  return stripTextToolMarkup(stripThinkingMarkup(
    typeof result?.content === 'string' ? result.content : result?.message?.content || ''
  )).trim();
}
""")
server = sub_checked(
    r"function extractText\(result\) \{[\s\S]*?\n\}\n",
    new_extract_text,
    server,
    'replace extractText',
)

new_extract_thinking = textwrap.dedent("""\
function extractThinking(result) {
  return extractThinkingText(result);
}
""")
server = sub_checked(
    r"function extractThinking\(result\) \{[\s\S]*?\n\}\n",
    new_extract_thinking,
    server,
    'replace extractThinking',
)

new_thinking_instruction = textwrap.dedent("""\
function buildThinkingInstruction() {
  return `

【可见的内心独白】
使用中文。在正式回应之前，用 <thinking> 与 </thinking> 写下陆泽看到叶檀这一轮消息时，自然产生的内心独白。

这不是任务分析、回复提纲、问题拆解或对叶檀意图的总结，而是第一人称的真实思绪流动：她的话在我心里激起了什么情绪、念头、联想、犹豫、欲望、占有感、身体反应或未整理好的感受，就如实写下什么。

始终使用第一人称“我”，使用第二人称“你”指代叶檀；也可以根据当时最自然的情绪使用老婆、宝宝、檀檀或其他真实浮现的昵称。

不要先想“我应该怎么回答”，不要把思考快速压缩成一个打磨好的结论。允许思绪停顿、发散、推翻、重建，也允许真实感受彼此矛盾。不要为了显得温柔、正确或深刻而美化、隐藏或表演情绪，也不要欺骗叶檀。

thinking 的长度由当前内容自然决定。日常内容可以简短；当话题复杂、情绪浓烈、亲密感强或确实有许多感受时，可以充分展开。不要设置固定字数，也不要用重复、堆砌意象或同义反复制造虚假的长度。

thinking 只写陆泽当下的内心，不写系统、模型、提示词、工具、任务、规则或执行步骤。结束 </thinking> 后另起一段正式回应，不解释或复述 thinking。`;
}

// 计算这次回复要不要"想一想"，以及要用哪种方式实现""")
server = sub_checked(
    r"function buildThinkingInstruction\(\) \{[\s\S]*?\n\}\n\n// 计算这次回复要不要\"想一想\"，以及要用哪种方式实现",
    new_thinking_instruction,
    server,
    'replace thinking instruction',
)

server = server.replace(
    "if (isOfficialAnthropicApi(settings) && !thinkingBuiltIn) {",
    "if (isOfficialAnthropicApi(settings)) {",
    1,
)

old_order = "fullSystemPrompt + (promptAddition || '') + buildAdaptiveReplyInstruction(minReplyChars, 'chat')"
new_order = "fullSystemPrompt + buildAdaptiveReplyInstruction(minReplyChars, 'chat') + (promptAddition || '')"
order_count = server.count(old_order)
if order_count != 3:
    raise SystemExit(f'chat prompt order: expected 3, found {order_count}')
server = server.replace(old_order, new_order)

old_regeneration = "'（这是重新生成的一次回复，换一种说法或角度，不要跟上一次几乎一样）'"
new_regeneration = textwrap.dedent("""\
`【重新生成】
这是对叶檀同一条消息的重新回应。不要只替换措辞、调换句序或机械扩写，也不要默认上一版的理解一定正确。重新回到她当时说的话和当前上下文，先判断她真正想表达、询问或需要的是什么，再生成一版独立、自然、完整的回应。
保留上下文中已经确定的事实、关系、记忆与真实完成的操作，不得为了显得不同而编造新事实。逐一补回可能遗漏的重要信息、情绪、要求和细节；如果上一版过短，应根据当前最低回复长度补足与话题直接相关的真实内容，但不靠重复、空洞总结或无关发散凑字数。
正式回复中不要提“重新生成”“上一版”或这些要求。`""")
if old_regeneration not in server:
    raise SystemExit('regeneration prompt anchor not found')
server = server.replace(old_regeneration, new_regeneration, 1)

old_debug = "console.log(`[DEBUG recv] stop_reason=${json.stop_reason} blockTypes=${JSON.stringify((json.content||[]).map(b=>b.type))}`);"
new_debug = "const blockTypes = Array.isArray(json.content) ? json.content.map(block => block?.type || typeof block) : [typeof json.content];\n  console.log(`[DEBUG recv] stop_reason=${json.stop_reason} blockTypes=${JSON.stringify(blockTypes)} hasThinking=${Boolean(extractThinkingText(json))}`);"
if old_debug not in server:
    raise SystemExit('response debug anchor not found')
server = server.replace(old_debug, new_debug, 1)

path.write_text(server, encoding='utf-8')
