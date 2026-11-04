'use strict';

const DEFAULT_MIN_SIGNAL = 220;
const MEMORY_JOURNAL_MODE = String(process.env.MEMORY_JOURNAL_MODE || 'smart').toLowerCase();
const MEMORY_JOURNAL_MIN_SIGNAL = clampMinSignal(process.env.MEMORY_JOURNAL_MIN_SIGNAL);

function clampMinSignal(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MIN_SIGNAL;
  return Math.max(200, Math.min(600, parsed));
}

// Only the user's own text may trigger a background journal call. The former
// implementation also inspected the assistant reply, so a long reply could make
// even "嗯嗯/继续/亲亲" spend another model request.
const HIGH_SIGNAL_RE = /(?:ourhome|agentmail|vercel|supabase|mcp|github|api\b|部署|上线|报错|故障|失败|修复|优化|重构|排查|合并|回滚|模型切换|上下文|思考链|整理记忆|记忆规则|长期记忆|临时记忆|记忆更新|记忆同步|记忆整理|记忆延迟|接续记忆|近期记忆|记住我|帮我记住|以后.{0,12}(?:记得|记住|不要|别|保持|改成|调整)|从现在开始|之后(?:请|都|每次)|稳定偏好|偏好设置|人设|规则库|世界书|收藏|置顶|课表|教学|备课|论文|毕业|面试|简历|学生(?:写作|作文|教学)?|工作|我(?:一直)?不喜欢.{0,10}(?:风格|语气|称呼|排版|表达|功能|设计|模型|颜色|界面)|我(?:一直)?喜欢.{0,10}(?:风格|语气|称呼|排版|表达|功能|设计|模型|颜色|界面))/i;

// A short task request should enter the zero-cost journal path. The provider
// guard will persist it locally only when the assistant reply confirms it is
// still unfinished; completed one-shot help and casual chat remain no-ops.
const PENDING_WORK_REQUEST_RE = /(?:帮我|帮忙|看看|检查|核对|排查|梳理|整理|修(?:一下|下|好)?|改(?:一下|下|好)?|优化|部署|上线|处理|弄一下|做一下|查一下|解决|润色|制作|生成|备课|测试|上传|补充|添加|删除|移动|放到|移到)/i;

// Meaningful recent-state reports are memory candidates even when they are not
// requests or unfinished tasks. Keep the window/context explicit so transient
// one-off sensations and small talk do not trigger a journal analysis.
const RECENT_LIFE_UPDATE_RE = /(?:我(?:最近|这几天|这段时间|目前|现在|今天|昨天|前几天|上周|刚刚|刚才)|(?:最近|这几天|这段时间|今天|昨天|前几天|上周)).{0,40}(?:开始|正在|在做|做了|完成|结束|去了|回来|换了|入职|离职|辞职|报名|参加|通过|遇到|发生|经历|发现|联系|见了|搬家|旅行|出差|上课|带班|备课|工作|上班|下班|考试|面试|学习|写了|提交|收到|更新|恢复|生病|看病|复查|治疗|加班|忙着|准备|计划|决定|处理|项目|学校|学生|论文|新岗位|新工作)|(?:最近|这几天|这段时间|目前).{0,24}(?:很忙|比较忙|压力大|状态|在学校|在公司|在家|做兼职|带高一|做视频|做动漫|备课比较多|工作比较多)/i;

function isRecentLifeUpdate(userText) {
  const user = String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  return Boolean(user && RECENT_LIFE_UPDATE_RE.test(user));
}

const SHORT_ACK_RE = /^(?:好|好的|嗯|嗯嗯|哦|噢|是|对|行|可以|收到|谢谢|谢谢啦|没事|亲亲|抱抱|继续|来吧|晚安|早安|在吗|喵|哈哈|哈)(?:[~～…，。！？!?\s]*)$/i;
const CONTINUATION_CUE_RE = /(?:继续(?:刚才|之前|上次|前面|这个|那个|往下|做|改|修|处理)?|接着(?:做|聊|处理|改|修|刚才|之前|上次)?|按(?:刚才|前面|上次)(?:说的|那个)?|照(?:刚才|前面|上次)(?:说的|那个)?|回到(?:刚才|前面|上次)(?:那个|的话题)?|上次那个|刚才那个|前面那个)/i;

function signalLength(value) {
  return String(value || '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s~～!！?？。,.，、…（）()[\]{}'"“”‘’/\\|_-]+/gu, '')
    .length;
}

function shouldAnalyzeMemoryJournalTurn({ userText } = {}) {
  if (MEMORY_JOURNAL_MODE === 'off') return false;
  if (MEMORY_JOURNAL_MODE === 'full') return true;

  const user = String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!user) return false;

  // An attachment alone should not launch another model. A meaningful caption
  // after the generated attachment marker is still evaluated normally.
  const substantiveUserText = user.replace(/^\[发送了附件[^\]]*\]\s*/i, '').trim();
  if (!substantiveUserText || SHORT_ACK_RE.test(substantiveUserText)) return false;

  if (HIGH_SIGNAL_RE.test(substantiveUserText)) return true;
  if (PENDING_WORK_REQUEST_RE.test(substantiveUserText)) return true;
  if (isRecentLifeUpdate(substantiveUserText)) return true;
  return signalLength(substantiveUserText) >= MEMORY_JOURNAL_MIN_SIGNAL;
}

function isMemoryContinuationCue(userText) {
  if (MEMORY_JOURNAL_MODE === 'off') return false;
  const user = String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return Boolean(user && CONTINUATION_CUE_RE.test(user));
}

function shouldAnalyzeMemoryJournalContinuation({ userText, existingContext } = {}) {
  if (!isMemoryContinuationCue(userText)) return false;
  const hasActiveMarks = Array.isArray(existingContext?.openMarks) && existingContext.openMarks.length > 0;
  const summaryThreads = Array.isArray(existingContext?.summary?.open_threads)
    ? existingContext.summary.open_threads
    : [];
  const hasOpenSummaryThreads = summaryThreads.some(item => String(item || '').trim());
  return hasActiveMarks || hasOpenSummaryThreads;
}

module.exports = {
  DEFAULT_MIN_SIGNAL,
  MEMORY_JOURNAL_MIN_SIGNAL,
  signalLength,
  shouldAnalyzeMemoryJournalTurn,
  isRecentLifeUpdate,
  isMemoryContinuationCue,
  shouldAnalyzeMemoryJournalContinuation,
};
