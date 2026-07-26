'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { detectHardPrivacyRisks, parsePrivacyReview } = require('../emailPrivacy');

test('硬隐私检查会拦截密钥、手机号和私聊原文', () => {
  assert.deepEqual(
    detectHardPrivacyRisks({ text: 'API Key: sk_live_1234567890abcdef' }).map(item => item.code),
    ['credential'],
  );
  assert.equal(
    detectHardPrivacyRisks({ text: '可以联系我：13812345678' }).some(item => item.code === 'phone'),
    true,
  );
  assert.equal(
    detectHardPrivacyRisks({ text: '聊天记录：叶檀：晚安\n陆泽：抱抱你' }).some(item => item.code === 'raw_transcript'),
    true,
  );
});

test('普通公开问候不会被硬规则误拦', () => {
  assert.deepEqual(detectHardPrivacyRisks({
    subject: '周末问候',
    text: '最近在认真工作，也开始学着做短片。祝你周末愉快。',
    contextUsed: '概括后的工作近况',
  }), []);
});

test('隐私审查只接受结构正确且结论明确的 JSON', () => {
  assert.deepEqual(parsePrivacyReview('```json\n{"allowed":true,"reason":"只是普通问候","safe_summary":"工作近况"}\n```'), {
    allowed: true,
    reason: '只是普通问候',
    safe_summary: '工作近况',
  });
  assert.equal(parsePrivacyReview('可以发送').allowed, false);
  assert.equal(parsePrivacyReview('{"reason":"没问题"}').allowed, false);
});
