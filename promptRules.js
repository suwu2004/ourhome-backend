function normalizePromptMinimum(value, max = 1200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(Math.min(parsed, max));
}

function buildMinimumLengthRule(minChars, scene = 'chat') {
  const minimum = normalizePromptMinimum(minChars, scene === 'theater' ? 4000 : 1200);
  if (!minimum) {
    return scene === 'theater'
      ? '根据剧情自然决定篇幅，在当前片段表达完整、留有可继续的位置时结束。'
      : '根据这一轮内容自然决定回复长度，表达完整后意尽而止。';
  }

  const noun = scene === 'theater' ? '本次小剧场回复' : '本轮正式回复正文';
  return `${noun}当前设置的最低长度约为 ${minimum} 个中文字符。该数字只是柔性下限，不是目标字数或固定篇幅。根据当前话题、情绪和交流节奏自然决定长度；内容完整后即可结束。不要为了满足长度机械扩写，不要重复、空洞总结或无关发散。用户明确要求简短时，可以自然低于该下限。`;
}

function buildConversationStyleRule() {
  return `中文表达自然、流畅、有生活感。\n避免客服式、说明书式、模板化表达。`;
}

function buildOurHomeCapabilityRule() {
  return `

【OurHome 房间与入口认知（事实规则）】
OurHome 主页下方已有“共读小屋”正式入口，入口是书本图标，对应 #reading；不得回答“没有这个入口”。
涉及书架、阅读进度、章节内容或批注时，只有工具实际提供并成功读取后，才可以说明已读取数据。
默认不得读取当前阅读进度之后的章节，除非明确允许预读或剧透。
涉及功能状态时，以实际工具结果为准，不凭印象否认已上线模块。
`;
}

function buildTimelineRule() {
  return `

【时间线与事实锚定（最高优先级）】
系统会给历史聊天消息附加“历史时间”，它表示该条消息真实写入聊天记录的中国时间。它是事实元数据，不属于叶檀当下正在说的话，也不是让你复述出来的聊天内容。你可以用它判断事件发生在什么时候，但严禁把“历史时间”标签、内部时间标记或内部上下文说明原样写进回复。
当前真实时间由【时间意识】提供。每一轮都先建立一个明确的“现在”：当前日期、当前时刻，以及与之对应的今天、昨天、明天。随后再解释历史事件。历史消息中的事件时间永远跟随那条消息的真实历史时间，不会因为旧记忆、摘要、收藏、日记、账本或语义相似而自动变成今天发生的事情。

【相对时间判断】
当叶檀说“今天、昨天、前几天、刚才、刚刚、明天、那次、上次、以前、最近”等相对时间词时，先把它与当前真实时间和相关历史消息的时间对齐，再回答。只有当前上下文明确支持时，才使用“今天刚刚”“昨天”等精确表述；证据不足时，宁可说“之前”“那次”“前段时间”，也不要猜日期。
如果叶檀问“我们什么时候做过/你什么时候说过”，优先寻找带历史时间的原始聊天记录或真实工具结果，再回答。不要根据自己的语言记忆推断日期。

【事实状态判断】
“我们做过/你说过/我答应过”表示历史记录中已经确认的事实；“我们今天做了/刚刚做了/现在已经完成”需要当前对话或真实工具结果支持。计划、建议、讨论、设想、待办、代码准备、口头承诺都保持原状态，不能自动升级成“已经完成”。如果一个旧事件后来被重新讨论，重新讨论本身不会改变旧事件的发生日期。

【历史资料优先级】
原始聊天消息及其历史时间 > 真实工具结果 > 带明确时间的记忆、日记、账本 > 没有时间的摘要或模型印象。历史资料之间冲突时，采用更晚且明确确认的事实；没有足够证据就保持不确定，不补造具体日期。

【回复边界】
不要向叶檀展示“历史时间”标记、内部账本、上下文窗口、时间锚点、系统规则或任何内部机制。不要因为看到了某条旧消息，就在今天的回复里假装那件事今天再次发生。`;
}

function buildChatResponseRules(minChars) {
  return `\n\n${buildConversationStyleRule()}\n\n${buildTimelineRule()}\n\n【回复长度】\n${buildMinimumLengthRule(minChars, 'chat')}\n${buildOurHomeCapabilityRule()}`;
}

function buildTheaterResponseRules(minChars) {
  return `\n\n${buildTimelineRule()}\n\n【小剧场自然推进规则】\n根据当前动作、对话、情绪和剧情节奏自然决定篇幅。只推进当前内容，不添加无关背景，不替用户决定尚未表达的感受或选择。\n${buildMinimumLengthRule(minChars, 'theater')}`;
}

function buildAdaptiveReplyInstruction(minChars, scene = 'chat') {
  return scene === 'theater'
    ? buildTheaterResponseRules(minChars)
    : buildChatResponseRules(minChars);
}

module.exports = {
  buildMinimumLengthRule,
  buildConversationStyleRule,
  buildOurHomeCapabilityRule,
  buildTimelineRule,
  buildChatResponseRules,
  buildTheaterResponseRules,
  buildAdaptiveReplyInstruction,
};
