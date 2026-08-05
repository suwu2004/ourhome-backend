const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAttachmentSummary,
  previousAttachmentLabel,
  latestImageMessageId,
} = require('../attachmentContext');

test('旧图片有识图摘要时会把内容带回后续上下文', () => {
  const label = previousAttachmentLabel({
    attachment_type: 'image/png',
    attachment_summary: '画面是一张 OC 问卷截图，能看到第 71 题和黑色相关答案。',
  });
  assert.match(label, /当时已经确认看到的内容/);
  assert.match(label, /第 71 题/);
});

test('旧图片没有摘要时不会假装记得内容', () => {
  const label = previousAttachmentLabel({ attachment_type: 'image/jpeg' });
  assert.match(label, /没有保存可复用的识图描述/);
});

test('附件摘要会清理多余空白并限制长度', () => {
  assert.equal(normalizeAttachmentSummary('  第一行\r\n\r\n\r\n\r\n第二行  '), '第一行\n\n\n第二行');
  assert.equal(normalizeAttachmentSummary('a'.repeat(4000)).length, 3200);
});

test('会找到历史里最近一条图片消息', () => {
  const id = latestImageMessageId([
    { id: 1, attachment_url: 'a', attachment_type: 'image/png' },
    { id: 2 },
    { id: 3, attachment_url: 'b', attachment_type: 'image/jpeg' },
  ]);
  assert.equal(id, 3);
});
