'use strict';

function compactLine(value, max = 1200) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function assessLongMemoryCandidate(summary, sourceText = '') {
  const text = compactLine(summary, 500);
  if (!text) return { ok: false, reason: '长期记忆内容为空' };
  if (text.length < 8) return { ok: false, reason: '这条太短，不适合作为长期记忆' };
  if (text.length > 260) return { ok: false, reason: '这条太长，先整理成一条稳定事实再存长期记忆' };

  // Validate against the original user turn too: a good paraphrase may omit
  // trigger words such as “不喜欢” while preserving the user's preference.
  const source = compactLine(sourceText, 1200);
  const evidence = [text, source].filter(Boolean).join('\n');
  const stableSignals = [
    '喜欢', '不喜欢', '偏好', '希望', '想要', '不想要', '讨厌', '害怕', '介意', '在意',
    '习惯', '总是', '通常', '每次', '长期', '固定', '以后', '默认',
    '界限', '底线', '雷点', '禁忌', '约定', '承诺', '决定', '保留', '取消', '改成', '放在',
    '生日', '纪念日', '重要日子', '人设', '设定', '称呼', '身份',
    'OurHome', 'API', '模型', 'GitHub', 'Supabase', 'Vercel', 'Render',
    '记忆', '便签', '日记', '邮箱', '金库', '设置', '主页',
  ];
  const diaryOnlySignals = [
    '今天', '昨天', '刚刚', '刚才', '早上', '上午', '中午', '下午', '晚上', '今晚',
    '这轮', '这次聊天', '聊到', '说起', '提到', '问了', '回复了',
    '心情', '情绪', '撒娇', '亲亲', '抱抱', '开心', '难过', '焦虑', '委屈',
  ];
  const unstableOnlySignals = ['可能', '也许', '暂时', '随便', '好像', '感觉', '突然', '准备去', '计划去'];

  const hasStableSignal = stableSignals.some(signal => evidence.includes(signal));
  const hasDiaryOnlySignal = diaryOnlySignals.some(signal => evidence.includes(signal));
  const hasUnstableOnlySignal = unstableOnlySignals.some(signal => evidence.includes(signal));
  const hasExplicitMemoryIntent = /记住|长期记忆|以后要记得|需要记得|别忘/.test(evidence);
  const isPreferenceOrBoundary = /喜欢|不喜欢|偏好|想要|不想要|讨厌|介意|界限|底线|雷点|禁忌|称呼|人设|设定/.test(evidence);
  const isProjectDecision = /(OurHome|API|模型|GitHub|Supabase|Vercel|Render|记忆|便签|日记|邮箱|金库|设置|主页).*(决定|需要|必须|以后|默认|保留|取消|改成|放在|权限|开启|关闭)/.test(evidence);

  if (!hasStableSignal) {
    return { ok: false, reason: '这条更像聊天碎片，先放在今日摘要或未完待续，不进长期记忆' };
  }
  if (hasDiaryOnlySignal && !hasExplicitMemoryIntent && !isPreferenceOrBoundary && !isProjectDecision) {
    return { ok: false, reason: '这条更像当天记录，适合留在今日摘要，不进长期记忆' };
  }
  if (hasUnstableOnlySignal && !hasExplicitMemoryIntent && !isPreferenceOrBoundary && !isProjectDecision) {
    return { ok: false, reason: '这条还不够稳定，先别写进长期记忆' };
  }
  return { ok: true };
}

function deriveStablePreferenceMemory(userText) {
  const text = compactLine(userText, 1200);
  if (!text) return '';

  const hasPreferenceSignal = /不喜欢|不太喜欢|讨厌|偏好|希望|更喜欢|喜欢|不要总是|别再|不要再|以后不要|以后别/u.test(text);
  const hasWritingStyleTarget = /写.{0,12}(?:细腻|自然|氛围|描写|风格)|顿了顿|声音低了低|眼神暗了暗|过渡词|氛围|叙事|回复|回答|表达|语气|称呼|人设|模板|套话|动作描写|用词|句式/u.test(text);
  const hasRecurringOrSpecificFeedback = /老是|总是|经常|反复|每次|别再|不要再|以后|习惯|不太喜欢|不喜欢|顿了顿|过渡词|模板|套话/u.test(text);
  if (!hasPreferenceSignal || !hasWritingStyleTarget || !hasRecurringOrSpecificFeedback) return '';

  const cleaned = text.replace(/^(?:(?:唔|嗯|啊|那个|就是|其实)[，,。…\s]*)+/u, '').trim();
  return compactLine(`叶檀对陆泽的长期表达偏好：${cleaned}`, 245);
}

module.exports = { assessLongMemoryCandidate, deriveStablePreferenceMemory };
