const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DUPLICATE_STYLE_RULE,
  OLD_TIME_RULE,
  NEW_TIME_RULE,
  OLD_REGEN_RULE,
  NEW_REGEN_RULE,
  cleanupText,
  cleanupSystem,
} = require('../chatPromptCleanup');

test('去掉与数据库五条交流原则重复的额外风格规则', () => {
  const input = `人设正文\n\n${DUPLICATE_STYLE_RULE}\n\n【回复长度】\n根据这一轮内容自然决定回复长度，表达完整后意尽而止。`;
  const output = cleanupText(input);
  assert.equal(output.includes(DUPLICATE_STYLE_RULE), false);
  assert.match(output, /人设正文/);
  assert.match(output, /【回复长度】/);
});

test('时间意识只保留事实背景，不再主动催促和安排', () => {
  const output = cleanupText(`【时间意识】\n现在是中国时间 2026年8月7日 16:00。\n${OLD_TIME_RULE}`);
  assert.equal(output.includes(OLD_TIME_RULE), false);
  assert.match(output, new RegExp(NEW_TIME_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(output, /不要因为时间本身主动问候、催睡、催吃饭/);
});

test('重新生成不再要求逐项补回或为了长度扩写', () => {
  const output = cleanupText(`【重新生成】\n${OLD_REGEN_RULE}`);
  assert.equal(output.includes('逐一补回可能遗漏'), false);
  assert.equal(output.includes('根据当前最低回复长度补足'), false);
  assert.match(output, /不要求逐项补回所有信息/);
  assert.match(output, /不要为了篇幅扩写/);
  assert.match(output, new RegExp(NEW_REGEN_RULE.slice(0, 20)));
});

test('支持 Anthropic system block 数组且不改无关人设内容', () => {
  const system = [
    { type: 'text', text: `陆泽人设\n\n${DUPLICATE_STYLE_RULE}` },
    { type: 'text', text: `【时间意识】\n${OLD_TIME_RULE}` },
    { type: 'text', text: '【记忆】今天一起吃了火锅。' },
  ];
  const output = cleanupSystem(system);
  assert.equal(output[0].text.includes(DUPLICATE_STYLE_RULE), false);
  assert.match(output[1].text, /只作为事实背景/);
  assert.equal(output[2].text, '【记忆】今天一起吃了火锅。');
});
