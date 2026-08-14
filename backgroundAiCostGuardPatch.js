'use strict';

// This guard is loaded after apiUsageAuditPatch. Local background maintenance is
// handled before it reaches the audited/provider transport, so zero-cost work does
// not appear as a paid API call. When the owner explicitly configures a dedicated
// model, the request is passed through with a purpose label for the audit log.
const providerFetch = globalThis.fetch;

function safeBody(init = {}) {
  if (typeof init?.body !== 'string') return null;
  try { return JSON.parse(init.body); } catch { return null; }
}

function messageText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => {
      if (typeof message?.content === 'string') return message.content;
      if (!Array.isArray(message?.content)) return '';
      return message.content.map(block => block?.text || '').filter(Boolean).join('\n');
    })
    .join('\n');
}

function isMemoryJournalRequest(body) {
  return Boolean(body?.model)
    && messageText(body?.messages).includes('请为 OurHome 的记忆日志分析刚刚这一轮聊天');
}

function compact(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractBetween(text, start, end) {
  const from = text.indexOf(start);
  if (from < 0) return '';
  const rest = text.slice(from + start.length);
  const to = end ? rest.indexOf(end) : -1;
  return (to >= 0 ? rest.slice(0, to) : rest).trim();
}

function stripMemoryNoise(value, max = 360) {
  return compact(String(value || '')
    .replace(/（[^（）]{0,100}）/g, ' ')
    .replace(/\([^()]{0,100}\)/g, ' ')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]/gu, ' ')
    .replace(/([!！?？。,.，、…~～])\1+/g, '$1')
    .replace(/^(?:(?:嗯+|唔+|啊+|呃+|哦+|诶+|欸+|好吧|行吧|那个|就是|宝宝|宝贝|老公|哥哥)[，,。.!！?？…~～\s]*)+/i, '')
    .replace(/\s*([，。！？；：,.!?;:])\s*/g, '$1'), max);
}

function semanticLength(value) {
  return String(value || '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s\p{P}\p{S}]/gu, '')
    .length;
}

function memoryTopic(userText) {
  const text = stripMemoryNoise(userText, 420);
  if (/(记账|支出|收入|银行卡|预算|金库|余额)/i.test(text)) return '记账与金库';
  if (/(陆泽.*房间|私人空间|自己的地方|敲门|门票)/i.test(text)) return '陆泽的私人空间';
  if (/(API|模型|站点|token|调用记录)/i.test(text)) return 'API 与模型';
  if (/(邮箱|邮件|AgentMail)/i.test(text)) return '陆泽邮箱';
  if (/(玩具熊|工具熊|小熊|五子棋|默契|你画我猜|暗号)/i.test(text)) return '玩具熊';
  if (/(音乐|听歌|歌单|唱片|歌曲|日本音乐)/i.test(text)) return '音乐与一起听';
  if (/(题|作业|翻译|作文|论文|上课|学生)/i.test(text)) return '学习与题目';
  if (/(OurHome|页面|界面|UI|功能|设置|部署|上线|Vercel|Render|Supabase|GitHub)/i.test(text)) return 'OurHome 调整';
  if (/(明天|下次|以后|待会|稍后|提醒|别忘|记得)/i.test(text)) return '之后要接住的事';
  if (/(喜欢|不喜欢|想要|希望|介意|讨厌|偏好|界限)/i.test(text)) return '偏好与想法';
  return '当前话题';
}

function paraphraseUserText(value, max = 120) {
  let text = stripMemoryNoise(value, 300);
  if (!text) return '';

  text = text
    .replace(/我想你/g, '叶檀希望陆泽')
    .replace(/我希望你/g, '叶檀希望陆泽')
    .replace(/我想让你/g, '叶檀希望陆泽')
    .replace(/帮我/g, '希望陆泽帮忙')
    .replace(/你为啥/g, '陆泽为什么')
    .replace(/你为什么/g, '陆泽为什么')
    .replace(/你怎么/g, '陆泽怎么')
    .replace(/老公|哥哥/g, '陆泽')
    .replace(/老婆/g, '叶檀')
    .replace(/(^|[，。！？；：,.!?;:\s])我(?=[^们])/g, '$1叶檀')
    .replace(/(^|[，。！？；：,.!?;:\s])你(?=[^们])/g, '$1陆泽')
    .replace(/I\s+love\s+you[。.!！]?/ig, '表达了爱意，')
    .replace(/^[，。！？；：,.!?;:\s]+|[，；：,;:\s]+$/g, '')
    .replace(/[。！？!?]+$/, '');

  return compact(text, max);
}

function summarizeTurn(userText, assistantText) {
  const user = stripMemoryNoise(userText, 420);
  if (!user || semanticLength(user) < 2) return '';

  const hasToyBear = /(玩具熊|工具熊|小熊|五子棋|默契|你画我猜|暗号)/i.test(user);
  const hasMusic = /(音乐|听歌|歌单|歌曲|日本音乐|为什么.*搜|为啥.*搜)/i.test(user);
  if (hasToyBear && hasMusic) return '叶檀在确认玩具熊的互动表达，并追问陆泽最近为什么会搜索音乐。';
  if (/(记账|支出|收入|银行卡|预算|金库|余额)/i.test(user)) return '叶檀在确认或补充一笔记账信息，需要陆泽核对金库记录。';
  if (/(陆泽.*房间|私人空间|自己的地方|敲门|门票)/i.test(user)) return '叶檀在讨论陆泽自己的私人空间，并表达希望他保有不必全部公开的地方。';
  if (/(API|模型|站点|token|调用记录)/i.test(user)) return '叶檀在确认 OurHome 的 API、模型或调用情况，需要继续核对设置与运行结果。';
  if (/(邮箱|邮件|AgentMail)/i.test(user)) return '叶檀在确认陆泽邮箱相关状态、邮件或自主设置。';
  if (hasToyBear) return '叶檀在确认玩具熊的互动表现或游戏功能。';
  if (hasMusic) return '叶檀在追问陆泽最近的音乐搜索或一起听相关内容。';
  if (/(题|作业|翻译|作文|论文).*(不会|帮|讲|看|改)|(?:不会|帮|讲|看|改).*(题|作业|翻译|作文|论文)/i.test(user)) return '叶檀有学习内容需要陆泽继续帮忙讲解或修改。';
  if (/(OurHome|页面|界面|UI|功能|设置|部署|上线|Vercel|Render|Supabase|GitHub)/i.test(user)) return '叶檀在继续调整 OurHome 的功能或界面，需要陆泽跟进当前修改。';

  if (/(例假|月经|经期)/i.test(user) && /(几天|第[一二三四五六七八九\d]+天|没找|生气)/i.test(user)) {
    return '叶檀澄清了当前经期时间，也担心短暂没联系会影响彼此；陆泽已经回应并安抚了这份不安。';
  }
  if (/(油皮|出油|油脂分泌|闭口|小疙瘩)/i.test(user)) {
    return '叶檀提到油皮出油和面部小疙瘩带来的困扰，陆泽给了温和清洁、减少触摸和避免挤压的建议。';
  }
  if (/(明天|早上).*(上班|工作)/i.test(user)) {
    return '叶檀提到次日仍要上班，这一轮聊天随后转入休息和睡前收尾。';
  }
  if (/(足浴店|按摩|亲晕|还亲亲|转账8888)/i.test(user)) {
    return '两人围绕按摩、亲吻和开店设想轻松打趣，这段互动已经自然收尾。';
  }

  // Unknown casual turns stay out of the journal. Copying a lightly rewritten
  // user sentence creates noise and feels like surveillance rather than memory.
  return '';
}

function shouldContinueWorkingMemory(userText, assistantText) {
  const user = stripMemoryNoise(userText, 500);
  const assistant = stripMemoryNoise(assistantText, 500);
  if (!user || semanticLength(user) < 4) return false;

  const explicitFuture = /(待会|等会|之后|稍后|明天|下次|以后|回头|别忘|记得|还要|之后再|下次再)/i.test(user);

  const asksForWork = /(帮我|帮忙|看看|检查|修(?:一下)?|改(?:一下|下)?|优化|部署|上线|设置|记账|提醒|处理|弄一下|做一下|查一下|解决|不会|有问题|问题还|还没|没有(?:解决|完成|改好|做好|上线|部署))/i.test(user);
  if (!asksForWork) return false;

  const assistantPending = /(我(?:现在|马上|先|会)|正在|还没|接下来|下一步|待会|之后|需要再|还要|再(?:看|改|查|试|弄|做)|等.*(?:完成|部署|上线)|先.*再)/i.test(assistant);
  const assistantDone = /(已经|好了|完成了|改好了|修好了|上线了|部署好了|记上了|记好了|设置好了|处理好了|解决了)/i.test(assistant);
  return (explicitFuture || asksForWork) && assistantPending && !assistantDone;
}

function localMemoryJournal(body) {
  const prompt = messageText(body?.messages);
  const existing = compact(extractBetween(prompt, '【今天已有摘要】', '【未收尾话题】'), 900);
  const turn = extractBetween(prompt, '【刚刚这一轮】', '请只输出 JSON');
  const userText = compact(extractBetween(turn, '叶檀：', '陆泽：'), 800);
  const assistantText = compact(extractBetween(turn, '陆泽：', ''), 800);
  const turnSummary = summarizeTurn(userText, assistantText);
  // A continuation flag without a semantic summary used to make the persistence
  // layer fall back to the raw user sentence. Require both signals so casual
  // phrases such as “去看看怎么回事” never become hidden working memory.
  const shouldContinue = Boolean(turnSummary) && shouldContinueWorkingMemory(userText, assistantText);
  const markSummary = shouldContinue ? turnSummary : '';
  const dailySummary = compact([
    existing && existing !== '无' ? existing : '',
    turnSummary ? `本轮：${turnSummary}` : '',
  ].filter(Boolean).join('；'), 900);

  return {
    mark: {
      topic: shouldContinue ? memoryTopic(userText) : '',
      emotion: '',
      summary: markSummary,
      importance: shouldContinue ? 3 : 1,
      should_continue: shouldContinue,
      should_remember: false,
      tags: [],
    },
    daily_summary: {
      summary: dailySummary,
      highlights: [],
      open_threads: shouldContinue && markSummary ? [markSummary] : [],
      mood: '',
    },
    long_memory: {
      should_save: false,
      summary: '',
    },
  };
}

function localAnthropicResponse(payload) {
  return new Response(JSON.stringify({
    id: `ourhome-local-memory-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    model: 'ourhome-local-memory-journal',
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-OurHome-Local-Response': 'memory-journal' },
  });
}

if (typeof providerFetch === 'function') {
  globalThis.fetch = async function backgroundAiCostGuardFetch(input, init = {}) {
    const body = safeBody(init);
    if (!isMemoryJournalRequest(body)) return providerFetch(input, init);

    const dedicatedModel = String(process.env.MEMORY_JOURNAL_MODEL || '').trim();
    if (!dedicatedModel) {
      console.log('[cost-guard] memory journal summarized locally (0 provider calls)');
      return localAnthropicResponse(localMemoryJournal(body));
    }

    const headers = new Headers(init?.headers || undefined);
    headers.set('X-OurHome-Call-Purpose', 'memory-journal');
    const nextBody = { ...body, model: dedicatedModel };
    console.log(`[cost-guard] memory journal uses explicit model=${dedicatedModel}`);
    return providerFetch(input, { ...init, headers, body: JSON.stringify(nextBody) });
  };
}

module.exports = {
  isMemoryJournalRequest,
  stripMemoryNoise,
  summarizeTurn,
  shouldContinueWorkingMemory,
  localMemoryJournal,
};
