'use strict';

const HARD_PRIVACY_PATTERNS = Object.freeze([
  {
    code: 'credential',
    label: '密钥、密码或访问令牌',
    pattern: /(?:authorization\s*:\s*bearer\s+\S+|(?:api\s*key|api\s*密钥|密钥|密码|口令|access\s*token|refresh\s*token|secret)\s*[:：=]\s*\S{6,}|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{12,}\b)/i,
  },
  {
    code: 'phone',
    label: '完整手机号码',
    pattern: /(?:^|[^\d])1[3-9]\d{9}(?:[^\d]|$)/,
  },
  {
    code: 'identity',
    label: '身份证或银行卡号',
    pattern: /(?:^|[^\d])(?:\d{17}[\dXx]|(?:\d[ -]?){16,19})(?:[^\d]|$)/,
  },
  {
    code: 'coordinates',
    label: '精确定位坐标',
    pattern: /(?:^|\s)-?\d{1,3}\.\d{4,}\s*[,，]\s*-?\d{1,3}\.\d{4,}(?:\s|$)/,
  },
  {
    code: 'internal_prompt',
    label: '系统提示词或内部思考',
    pattern: /(?:<thinking>|<\/thinking>|system\s*prompt|系统提示词|人物提示词|内部工具调用)/i,
  },
  {
    code: 'raw_transcript',
    label: '私聊原文或成段聊天记录',
    pattern: /(?:聊天记录|私聊原文)[：:\s]*[\s\S]{0,120}(?:叶檀|檀檀|老婆)[：:][\s\S]{0,600}(?:陆泽|老公)[：:]/i,
  },
]);

function normalizeText(value, max = 100_000) {
  return String(value ?? '').trim().slice(0, max);
}

function detectHardPrivacyRisks({ subject = '', text = '', contextUsed = '' } = {}) {
  const content = [subject, text, contextUsed].map(value => normalizeText(value)).filter(Boolean).join('\n');
  return HARD_PRIVACY_PATTERNS
    .filter(rule => rule.pattern.test(content))
    .map(rule => ({ code: rule.code, label: rule.label }));
}

function parsePrivacyReview(value) {
  const raw = normalizeText(value, 10_000).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { allowed: false, reason: '隐私审查没有返回可验证的结果', safe_summary: '' };
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (typeof parsed.allowed !== 'boolean') {
      return { allowed: false, reason: '隐私审查结果缺少明确结论', safe_summary: '' };
    }
    return {
      allowed: parsed.allowed,
      reason: normalizeText(parsed.reason, 1200) || (parsed.allowed ? '未发现不适合外发的私人内容' : '发现不适合外发的私人内容'),
      safe_summary: normalizeText(parsed.safe_summary, 1200),
    };
  } catch {
    return { allowed: false, reason: '隐私审查结果无法解析', safe_summary: '' };
  }
}

module.exports = {
  detectHardPrivacyRisks,
  parsePrivacyReview,
};
