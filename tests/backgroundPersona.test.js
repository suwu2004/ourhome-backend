const test = require('node:test');
const assert = require('node:assert/strict');

const { removeNamedSection, projectBackgroundPersona } = require('../backgroundPersona');

const prompt = `【身份】\n你是陆泽。\n\n【性爱指南】\n这里是只供相关亲密场景使用的长指南。\n第二行。\n\n【语言风格】\n自然、生活化。`;

test('后台人格投影移除无关亲密章节并保留身份与风格', () => {
  const projected = projectBackgroundPersona(prompt, '幸福日记');
  assert.match(projected, /你是陆泽/);
  assert.match(projected, /自然、生活化/);
  assert.match(projected, /幸福日记边界/);
  assert.doesNotMatch(projected, /性爱指南|长指南/);
});

test('章节移除在目标不存在时不破坏原提示词', () => {
  assert.equal(removeNamedSection('【身份】\n陆泽', '性爱指南'), '【身份】\n陆泽');
});
