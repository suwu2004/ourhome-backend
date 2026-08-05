const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRuleInput,
  parseLegacyRulesContent,
  compileTheaterRules,
} = require('../theaterRuleStore');

test('通用规则输入会被安全规范化', () => {
  const value = normalizeRuleInput({
    title: '  语言表达规则  ',
    content: '第一条。\r\n\r\n\r\n\r\n第二条。  ',
    enabled: false,
    sort_order: 12.6,
    source_name: ' language.docx ',
  });

  assert.equal(value.title, '语言表达规则');
  assert.equal(value.content, '第一条。\n\n\n第二条。');
  assert.equal(value.enabled, false);
  assert.equal(value.sort_order, 13);
  assert.equal(value.source_name, 'language.docx');
});

test('旧单条规则 JSON 可以迁移为正文', () => {
  assert.equal(
    parseLegacyRulesContent(JSON.stringify({ rules: '亲吻细节\n动作递进' })),
    '亲吻细节\n动作递进',
  );
});

test('只编译启用规则并保留顺序和标题', () => {
  const compiled = compileTheaterRules([
    { title: '语言', content: '避免套话。', enabled: true, sort_order: 20 },
    { title: '停用', content: '不应出现。', enabled: false, sort_order: 0 },
    { title: '亲吻', content: '写清动作。', enabled: true, sort_order: 10 },
  ]);

  assert.equal(compiled, '【亲吻】\n写清动作。\n\n【语言】\n避免套话。');
  assert.doesNotMatch(compiled, /不应出现/);
});
