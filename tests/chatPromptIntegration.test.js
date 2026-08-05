const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('旧的重复人格和 thinking 规则不再常驻注入', () => {
  assert.doesNotMatch(server, /prompt \+= DIALOGUE_STYLE_RULES/);
  assert.doesNotMatch(server, /prompt \+= THINKING_RULES/);
  assert.doesNotMatch(server, /正式回复保持一到三段/);
  assert.doesNotMatch(server, /有一点迟疑、心疼、在意/);
});

test('长度提醒在前，可见内心独白指令在最后，不会再被后续规则压掉', () => {
  const matches = server.match(/fullSystemPrompt \+ buildAdaptiveReplyInstruction\(minReplyChars, 'chat'\) \+ \(promptAddition \|\| ''\)/g) || [];
  assert.equal(matches.length, 3);
  assert.match(server, /【可见的内心独白】/);
  assert.match(server, /真实思绪流动/);
  assert.doesNotMatch(server, /除非本轮后续规则明确要求 thinking/);
});

test('官方 Anthropic 在需要思考时使用原生 thinking 参数', () => {
  assert.match(server, /if \(isOfficialAnthropicApi\(settings\)\) \{/);
});

test('不同中转站的 thinking 返回格式会统一提取', () => {
  assert.match(server, /extractThinkingText/);
  assert.match(server, /stripThinkingMarkup/);
});

test('重新生成会重新理解原消息而不是只换说法', () => {
  assert.match(server, /【重新生成】/);
  assert.match(server, /不要只替换措辞、调换句序或机械扩写/);
  assert.match(server, /重新回到她当时说的话和当前上下文/);
  assert.match(server, /不要提“重新生成”“上一版”/);
});

test('识图描述会写回消息并用于之后的旧图片上下文', () => {
  assert.match(server, /previousAttachmentLabel\(m\)/);
  assert.match(server, /attachment_summary/);
  assert.match(server, /persistAttachmentSummary/);
  assert.match(server, /latestImageMessageId/);
});
