from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)

support_path = Path('theaterMemorySupport.js')
support = support_path.read_text()
support = replace_once(support, "    version: 1,\n", "    version: 2,\n", 'empty version')
support = replace_once(support, "    version: 1,\n    character_anchor: compactBlock(value.character_anchor, 4200),\n    relationship_memory: compactBlock(value.relationship_memory, 2600),\n    plot_facts: normalizeList(value.plot_facts, 24, 320),\n    current_state: compactBlock(value.current_state, 1800),\n    open_threads: normalizeList(value.open_threads, 10, 260),\n    locked_notes: compactBlock(value.locked_notes, 3200),\n    turns_since_refresh: Math.max(0, Math.min(20, Number.parseInt(value.turns_since_refresh, 10) || 0)),\n", "    version: 2,\n    character_anchor: compactBlock(value.character_anchor, 4600),\n    relationship_memory: compactBlock(value.relationship_memory, 4200),\n    plot_facts: normalizeList(value.plot_facts, 60, 300),\n    current_state: compactBlock(value.current_state, 2400),\n    open_threads: normalizeList(value.open_threads, 16, 280),\n    locked_notes: compactBlock(value.locked_notes, 4200),\n    turns_since_refresh: Math.max(0, Math.min(30, Number.parseInt(value.turns_since_refresh, 10) || 0)),\n", 'normalizer limits')
insert_after = "function normalizeList(value, limit = 12, itemMax = 260) {\n  const list = Array.isArray(value)\n    ? value\n    : String(value || '').split(/\\n|；|;/u);\n  return [...new Set(list.map(item => compactLine(item, itemMax)).filter(Boolean))].slice(0, limit);\n}\n"
addition = insert_after + "\nfunction mergeTheaterFacts(previous = [], next = [], limit = 60) {\n  const merged = [];\n  const seen = new Set();\n  for (const raw of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(next) ? next : [])]) {\n    const item = compactLine(raw, 300);\n    if (!item) continue;\n    const key = item.toLowerCase().replace(/[\\s，。！？、；：,.!?;:'\\\"“”‘’（）()【】\\[\\]-]+/gu, '');\n    if (!key || seen.has(key)) continue;\n    seen.add(key);\n    merged.push(item);\n  }\n  return merged.slice(Math.max(0, merged.length - Math.max(1, limit)));\n}\n"
support = replace_once(support, insert_after, addition, 'merge helper insertion')
old_prompt = "  if (memory.plot_facts.length) sections.push(`【已发生剧情事实】\\n${memory.plot_facts.map(item => `- ${item}`).join('\\n')}`);\n"
new_prompt = "  if (memory.plot_facts.length) {\n    const recentFacts = memory.plot_facts.slice(-36);\n    const archivedFacts = memory.plot_facts.slice(0, Math.max(0, memory.plot_facts.length - recentFacts.length));\n    if (archivedFacts.length) sections.push(`【长期事件档案】\\n这些都是已经发生过的旧剧情，不能因为时间久就否认或改写。\\n${archivedFacts.map(item => `- ${item}`).join('\\n')}`);\n    sections.push(`【近期核心剧情事实】\\n${recentFacts.map(item => `- ${item}`).join('\\n')}`);\n  }\n"
support = replace_once(support, old_prompt, new_prompt, 'prompt archive split')
support = replace_once(support, "  normalizeList,\n", "  normalizeList,\n  mergeTheaterFacts,\n", 'export merge helper')
support_path.write_text(support)

patch_path = Path('theaterMemoryPatch.js')
patch = patch_path.read_text()
patch = replace_once(patch, "  normalizeTheaterMemory,\n  parseMemoryRow,\n", "  normalizeTheaterMemory,\n  mergeTheaterFacts,\n  parseMemoryRow,\n", 'import merge helper')
patch = patch.replace('plot_facts 只保留已经发生且以后必须承认的事件，按时间和因果写，最多24条。', 'plot_facts 只保留已经发生且以后必须承认的事件，按时间和因果写；优先保留会影响身份、关系、承诺、秘密、伤病、地点和因果的事实，最多36条。')
patch = patch.replace('open_threads 写尚未解决的承诺、秘密、冲突和线索，最多10条。', 'open_threads 写尚未解决的承诺、秘密、冲突和线索，最多16条。')
patch = patch.replace('- 新发生的重要事件并入 plot_facts；去重，最多24条；不得把未发生的猜测写成事实。', '- plot_facts 只输出本轮新增、修正或重新确认的重要事实，最多18条；不要为了凑数重抄全部旧历史，不得把未发生的猜测写成事实。')
patch = patch.replace('- 已解决线索从 open_threads 移除，新悬念加入，最多10条。', '- 已解决线索从 open_threads 移除，新悬念加入，最多16条。')
old_return = "  return normalizeTheaterMemory({\n    ...current,\n    ...parsed,\n    locked_notes: current.locked_notes,\n"
new_return = "  return normalizeTheaterMemory({\n    ...current,\n    ...parsed,\n    plot_facts: mergeTheaterFacts(current.plot_facts, parsed.plot_facts, 60),\n    locked_notes: current.locked_notes,\n"
patch = replace_once(patch, old_return, new_return, 'preserve historical facts')
patch_path.write_text(patch)

test_path = Path('tests/theaterMemorySupport.test.js')
test_path.write_text("""'use strict';\n\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { normalizeTheaterMemory, mergeTheaterFacts, buildMemoryPromptBlock } = require('../theaterMemorySupport');\n\ntest('theater memory v2 preserves a deeper event history', () => {\n  const facts = Array.from({ length: 70 }, (_, index) => `剧情事实 ${index + 1}`);\n  const memory = normalizeTheaterMemory({ plot_facts: facts });\n  assert.equal(memory.version, 2);\n  assert.equal(memory.plot_facts.length, 60);\n  assert.equal(memory.plot_facts[0], '剧情事实 1');\n  assert.equal(memory.plot_facts.at(-1), '剧情事实 60');\n});\n\ntest('incremental theater facts merge without deleting old unique events', () => {\n  const merged = mergeTheaterFacts(['第一次见面是在雨夜', '答应会回来'], ['答应会回来', '一起搬进新家'], 60);\n  assert.deepEqual(merged, ['第一次见面是在雨夜', '答应会回来', '一起搬进新家']);\n});\n\ntest('memory prompt separates archived and recent plot facts', () => {\n  const facts = Array.from({ length: 45 }, (_, index) => `事件 ${index + 1}`);\n  const prompt = buildMemoryPromptBlock({ plot_facts: facts });\n  assert.match(prompt, /长期事件档案/);\n  assert.match(prompt, /近期核心剧情事实/);\n  assert.match(prompt, /事件 1/);\n  assert.match(prompt, /事件 45/);\n});\n""")
