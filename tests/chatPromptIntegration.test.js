const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('旧的重复对话与 thinking 规则不再常驻注入', () => {
  assert.doesNotMatch(server, /prompt \+= DIALOGUE_STYLE_RULES/);
  assert.doesNotMatch(server, /prompt \+= THINKING_RULES/);
  assert.doesNotMatch(server, /正式回复保持一到三段/);
  assert.doesNotMatch(server, /有一点迟疑、心疼、在意/);
});

test('本轮自然回应与最低长度规则排在 thinking 补充之后', () => {
  const matches = server.match(/fullSystemPrompt \+ \(promptAddition \|\| ''\) \+ buildAdaptiveReplyInstruction\(minReplyChars, 'chat'\)/g) || [];
  assert.equal(matches.length, 3);
});

test('识图描述会写回消息并用于之后的旧图片上下文', () => {
  assert.match(server, /previousAttachmentLabel\(m\)/);
  assert.match(server, /attachment_summary/);
  assert.match(server, /persistAttachmentSummary/);
  assert.match(server, /latestImageMessageId/);
});
