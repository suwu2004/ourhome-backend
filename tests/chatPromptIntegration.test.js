const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const thinkingTransportPatch = fs.readFileSync(path.join(__dirname, '..', 'thinkingTransportPatch.js'), 'utf8');

test('旧的重复人格和 thinking 规则不再常驻注入', () => {
  assert.doesNotMatch(server, /prompt \+= DIALOGUE_STYLE_RULES/);
  assert.doesNotMatch(server, /prompt \+= THINKING_RULES/);
  assert.doesNotMatch(server, /正式回复保持一到三段/);
  assert.doesNotMatch(server, /有一点迟疑、心疼、在意/);
});

test('每条聊天请求都会带入精简后的统一回复规则', () => {
  const matches = server.match(/fullSystemPrompt \+ buildAdaptiveReplyInstruction\(minReplyChars, 'chat'\) \+ \(promptAddition \|\| ''\)/g) || [];
  assert.equal(matches.length, 3);
  assert.doesNotMatch(server, /除非本轮后续规则明确要求 thinking/);
});

test('旧的想不想判断只在本地返回不想，不再向上游发请求', () => {
  assert.match(thinkingTransportPatch, /isThinkingDecisionRequest/);
  assert.match(thinkingTransportPatch, /fixedNoThinkResponse/);
  assert.match(thinkingTransportPatch, /text: '不想'/);
  assert.match(thinkingTransportPatch, /zero-cost|0 次|never become a paid provider call/i);
  assert.match(thinkingTransportPatch, /return fixedNoThinkResponse\(\)/);
});

test('Chat 不再注入可见思考协议，并保留真实原生 thinking 请求', () => {
  assert.doesNotMatch(thinkingTransportPatch, /VISIBLE_THINKING_PROTOCOL/);
  assert.doesNotMatch(thinkingTransportPatch, /appendVisibleThinkingProtocol/);
  assert.match(thinkingTransportPatch, /stripLegacyThinkingInstruction/);
  assert.doesNotMatch(thinkingTransportPatch, /delete body\.thinking/);
  assert.match(thinkingTransportPatch, /prepareMainChatRequest/);
  assert.match(thinkingTransportPatch, /Do not delete nextBody\.thinking here/);
  assert.match(thinkingTransportPatch, /headers\.delete\('anthropic-beta'\)/);
});

test('上游没有 reasoning 时就不显示想一想，不再本地伪造思考', () => {
  assert.doesNotMatch(thinkingTransportPatch, /guaranteeVisibleThinking/);
  assert.doesNotMatch(thinkingTransportPatch, /buildFallbackRequestBody/);
  assert.doesNotMatch(thinkingTransportPatch, /fallbackResponse\s*=\s*await\s+originalFetch/);
  assert.doesNotMatch(thinkingTransportPatch, /injectReasoningContent/);
  assert.doesNotMatch(thinkingTransportPatch, /deterministicFallbackThought/);
  assert.match(thinkingTransportPatch, /native-only-thinking-v8/);
});

test('server 兼容官方 Anthropic 原生 thinking，传输层不再误删', () => {
  assert.match(server, /if \(isOfficialAnthropicApi\(settings\)\) \{/);
  assert.doesNotMatch(thinkingTransportPatch, /delete body\.thinking/);
  assert.match(thinkingTransportPatch, /selected model path that requested native extended thinking/);
});

test('不同中转站的 thinking 返回格式会统一提取', () => {
  assert.match(server, /extractThinkingText/);
  assert.match(server, /stripThinkingMarkup/);
});

test('重新生成提示词保持原样并继续重新理解原消息', () => {
  assert.match(server, /【重新生成】/);
  assert.match(server, /不要只替换措辞、调换句序或机械扩写/);
  assert.match(server, /重新回到她当时说的话和当前上下文/);
  assert.match(server, /保留上下文中已经确定的事实、关系、记忆与真实完成的操作/);
  assert.match(server, /不要提“重新生成”“上一版”/);
});

test('识图描述会写回消息并用于之后的旧图片上下文', () => {
  assert.match(server, /previousAttachmentLabel\(m\)/);
  assert.match(server, /attachment_summary/);
  assert.match(server, /persistAttachmentSummary/);
  assert.match(server, /latestImageMessageId/);
});
