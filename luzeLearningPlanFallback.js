'use strict';

function compact(value, max = 360) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeLearningPlanResult(parsed, mode = 'curiosity') {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const query = compact(source.query, 360);
  if (query) {
    return {
      query,
      reason: compact(source.reason, 240),
      keywords: [...new Set((Array.isArray(source.keywords) ? source.keywords : [])
        .map(item => compact(item, 32))
        .filter(Boolean))].slice(0, 5),
      usedFallback: false,
    };
  }

  // The planning model occasionally returns prose or truncated JSON. Keep the
  // scheduled learning run useful without paying for another planning completion.
  if (mode === 'ourhome') {
    return {
      query: '如何在长对话中减少模型输入 token，同时保留重要记忆和当前对话？',
      reason: '刚才的选题格式没有完整回来，我先顺着 OurHome 正在面对的上下文问题继续查。',
      keywords: ['OurHome', '长对话', '上下文', '记忆'],
      usedFallback: true,
    };
  }

  return {
    query: '秋冬围巾的纤维结构如何影响保暖、重量和贴肤舒适度？',
    reason: '选题格式没有完整回来，我就从日常里一个实际的小问题继续逛。',
    keywords: ['围巾', '纤维', '保暖', '舒适度'],
    usedFallback: true,
  };
}

module.exports = { normalizeLearningPlanResult };
