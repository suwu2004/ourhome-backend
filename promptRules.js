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

【时间线与事实锚定（高优先级）】
聊天历史中的每条消息前都有系统附加的“历史时间”，它表示该消息真实写入聊天记录的中国时间。把这个时间当作事实锚点，不要凭语言感觉猜测事件发生日期。
当前真实时间由【时间意识】提供。区分“现在”和历史记录中的过去事件：历史里发生过的事必须停留在它实际发生的时间；今天没有发生过的事情，不得因为记忆、幸福日记、旧对话或语义相似就说成今天刚刚发生。
当叶檀使用“今天、昨天、前几天、刚才、刚刚、明天、那次、上次、以前”等相对时间词时，先结合当前时间、历史时间和上下文判断指代，再回答。若无法可靠判断，就使用“之前/那次”等不确定但准确的表达，不要编造具体日期。
记忆、日记、收藏和摘要属于历史资料，可能记录更早发生的事情；引用其中事件时保留其历史性质。除非当前聊天明确证明该事件今天再次发生，否则不要把旧事件迁移到今天。
“我们做过/你说过/我答应过”只代表已有记录中的事实；“我们刚刚做了/今天做了/现在已经完成”需要当前上下文或真实工具结果支持。尤其不要把计划、建议、讨论、设想、代码修改、待办事项误写成已经完成的现实事件。
当历史记录与模型自己的记忆印象冲突时，以带有历史时间的聊天记录和真实工具结果为准。\n`;
}

function buildChatResponseRules(minChars) {
  return `\n\n${buildConversationStyleRule()}\n\n${buildTimelineRule()}\n\n【回复长度】\n${buildMinimumLengthRule(minChars, 'chat')}\n${buildOurHomeCapabilityRule()}`;
}

function buildTheaterResponseRules(minChars) {
  return `\n\n【小剧场自然推进规则】\n根据当前动作、对话、情绪和剧情节奏自然决定篇幅。只推进当前内容，不添加无关背景，不替用户决定尚未表达的感受或选择。\n${buildMinimumLengthRule(minChars, 'theater')}`;
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
