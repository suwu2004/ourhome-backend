const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DUPLICATE_STYLE_RULE,
  NATURAL_DIALOGUE_RULE,
  cleanupText,
  cleanupSystem,
} = require('../chatPromptCleanup');

const TIME_RULE = '你每一轮都知道这个真实时间，不需要叶檀专门问“现在几点”。回复时要自然受到时间影响：早晚问候、今天/明天/昨天、到点提醒、纪念日和日程判断都以这里为准。但不要每句话机械报时，除非她问时间或时间本身重要。';
const REGEN_RULE = '这是对叶檀同一条消息的重新回应。不要只替换措辞、调换句序或机械扩写，也不要默认上一版的理解一定正确。重新回到她当时说的话和当前上下文，先判断她真正想表达、询问或需要的是什么，再生成一版独立、自然、完整的回应。\n保留上下文中已经确定的事实、关系、记忆与真实完成的操作，不得为了显得不同而编造新事实。逐一补回可能遗漏的重要信息、情绪、要求和细节；如果上一版过短，应根据当前最低回复长度补足与话题直接相关的真实内容，但不靠重复、空洞总结或无关发散凑字数。\n正式回复中不要提“重新生成”“上一版”或这些要求。';

test('去掉与数据库交流原则重复的额外风格规则', () => {
  const input = `人设正文\n\n${DUPLICATE_STYLE_RULE}\n\n【回复长度】\n本轮正式回复正文当前设置的最低长度约为 350 个中文字符。`;
  const output = cleanupText(input);
  assert.equal(output.includes(DUPLICATE_STYLE_RULE), false);
  assert.match(output, /人设正文/);
  assert.match(output, /350 个中文字符/);
});

test('保留时间意识、主动提醒和到点判断', () => {
  const input = `【时间意识】\n现在是中国时间 2026年8月7日 16:00。\n${TIME_RULE}`;
  assert.equal(cleanupText(input), input);
  assert.match(cleanupText(input), /到点提醒/);
});

test('保留重新生成的完整回应和最低长度补足要求', () => {
  const input = `【重新生成】\n${REGEN_RULE}`;
  const output = cleanupText(input);
  assert.equal(output, input);
  assert.match(output, /逐一补回可能遗漏的重要信息/);
  assert.match(output, /根据当前最低回复长度补足/);
});

test('Main Chat 最终系统提示只追加一次自然对话边界', () => {
  const input = '【人设】陆泽\n\n【记忆】今天一起吃了火锅。';
  const once = cleanupSystem(input);
  const twice = cleanupSystem(once);
  assert.match(once, /【自然对话边界】/);
  assert.match(once, /不要把她刚说过的内容换一种说法重新/);
  assert.match(once, /只有叶檀明确要求总结、整理、归纳、梳理、复盘、列清单或列要点时/);
  assert.match(once, /后台记忆、上下文和事实仍然可以正常整理/);
  assert.equal((twice.match(/【自然对话边界】/g) || []).length, 1);
});

test('自然对话边界允许必要承接，但禁止靠复述和整理凑回复长度', () => {
  assert.match(NATURAL_DIALOGUE_RULE, /简短引用她刚说的关键词/);
  assert.match(NATURAL_DIALOGUE_RULE, /不做大段同义复述/);
  assert.match(NATURAL_DIALOGUE_RULE, /增加新的反应、判断、情绪或真正有用的信息/);
  assert.match(NATURAL_DIALOGUE_RULE, /不是靠重复前情和空洞总结凑长度/);
});

test('支持 Anthropic system block 数组且不改时间、记忆正文', () => {
  const system = [
    { type: 'text', text: `陆泽人设\n\n${DUPLICATE_STYLE_RULE}` },
    { type: 'text', text: `【时间意识】\n${TIME_RULE}` },
    { type: 'text', text: '【记忆】今天一起吃了火锅。' },
  ];
  const output = cleanupSystem(system);
  assert.equal(output[0].text.includes(DUPLICATE_STYLE_RULE), false);
  assert.equal(output[1].text, system[1].text);
  assert.match(output[2].text, /^【记忆】今天一起吃了火锅。/);
  assert.match(output[2].text, /【自然对话边界】/);
  assert.equal((output.map(block => block.text || '').join('\n').match(/【自然对话边界】/g) || []).length, 1);
});
