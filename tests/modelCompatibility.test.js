const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTextToolBridge,
  parseTextToolCalls,
  stripTextToolMarkup,
  isToolCompatibilityError,
  hasImageContent,
  isLikelyVisionModel,
  chooseVisionModel,
  replaceImagesWithDescription,
} = require('../modelCompatibility');

test('文字工具协议只解析严格标签，并移除内部标记', () => {
  const result = {
    content: [{ type: 'text', text: '<ourhome_tool>{"name":"read_home_memos","input":{"include_completed":false}}</ourhome_tool>' }],
  };
  assert.deepEqual(parseTextToolCalls(result), [{ name: 'read_home_memos', input: { include_completed: false } }]);
  assert.equal(stripTextToolMarkup(result.content[0].text), '');
  assert.equal(parseTextToolCalls({ content: [{ type: 'text', text: '我没有工具。' }] }).length, 0);
  assert.match(buildTextToolBridge([{ name: 'read_home_memos', description: '读取便签', input_schema: { type: 'object', properties: {} } }]), /read_home_memos/);
});

test('工具格式不兼容错误可以安全降级到文字协议', () => {
  assert.equal(isToolCompatibilityError(new Error('[400] tools are not supported for this model')), true);
  assert.equal(isToolCompatibilityError(new Error('[400] unsupported parameter: tools')), true);
  assert.equal(isToolCompatibilityError(new Error('[400] this model does not support function calling')), true);
  assert.equal(isToolCompatibilityError(new Error('[503] no available channel')), false);
});

test('纯文字模型可以选择视觉模型代读图片', () => {
  const messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'abc' } }, { type: 'text', text: '看看这个' }] }];
  assert.equal(hasImageContent(messages), true);
  assert.equal(isLikelyVisionModel('deepseek-r1'), false);
  assert.equal(isLikelyVisionModel('gemini-3.1-pro-preview'), true);
  assert.equal(chooseVisionModel(['deepseek-r1', 'gpt-4o-mini', 'claude-4-sonnet'], 'deepseek-r1'), 'claude-4-sonnet');
  const bridged = replaceImagesWithDescription(messages, '一只趴着的小猫。', 'claude-4-sonnet');
  assert.equal(typeof bridged[0].content, 'string');
  assert.match(bridged[0].content, /一只趴着的小猫/);
});
