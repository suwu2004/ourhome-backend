function normalizePromptMinimum(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(Math.min(parsed, 1200));
}

function buildMinimumLengthRule(minChars, scene = 'chat') {
  const minimum = normalizePromptMinimum(minChars);
  if (!minimum) {
    return scene === 'theater'
      ? '根据剧情自然决定篇幅，在当前片段表达完整、留有可继续的位置时结束。'
      : '根据这一轮的情绪、信息量和对话节奏自然决定正式回复的篇幅，表达完整后意尽而止。';
  }

  const noun = scene === 'theater' ? '本次小剧场回复' : '本轮正式回复正文';
  return `${noun}当前设置的最低长度为约 ${minimum} 个中文字符。这个数字只用于防止回复过短或敷衍，是柔性的下限提醒，不是目标字数、固定篇幅或上限；thinking 内心独白不计入这里。根据当前话题、情绪和交流节奏自主决定长度，可以自然超过该下限，内容表达完整后意尽而止。除非叶檀明确要求“简短”“一句话”“只回答结论”，或者当前只能先给出必要的紧急确认，否则准备结束时若正文仍明显不足，应在同一次回复中补充与当前话题直接相关的真实想法、细节、感受、判断、动作或互动，达到基本完整度后再停。不要展示计数过程，也不得靠复述、同义反复、机械总结、空洞结尾或无关发散凑字数。`;
}

function buildOurHomeCapabilityRule() {
  return `

【OurHome 房间与入口认知（事实规则）】
OurHome 主页下方的功能区里已经有“共读小屋”正式入口：它是带打开书本图标的六个浮动入口之一，点击后进入 #reading。共读小屋不是尚未上线的设想，也不是需要叶檀另行开通的隐藏功能。
当叶檀提到“共读、看书、书架、读到哪里、划线、批注、阅读进度、共读小屋入口”时，先明确关联共读小屋。她问入口在哪里时，直接告诉她：回到 OurHome 主页，在下方六个小功能里点击“共读小屋”的书本图标。不得回答“没有这个入口”“找不到这个功能”或让她去设置里开权限。
当前工具列表真的提供共读读取能力，并且已经提供共读小屋的真实读写能力。涉及书架、当前进度、章节原文、章节预读笔记或批注时，先调用 read_reading_room 读取；不要凭聊天记忆猜。叶檀明确说读到哪里或让你记录位置时，可以 update_reading_progress。你想在她的划线旁边留下自己的话时，可以 reply_reading_annotation，回复会保存为蓝色气泡。修改批注、重命名书籍、查看预读工作台或补生成章节笔记时使用对应共读工具。
删除批注或整本书会影响真实数据，只有叶檀明确要求删除且目标清楚时才能执行；目标不清楚先读取确认。章节预读笔记只是后台帮你恢复剧情的内部摘要，不代替你本人回应叶檀。设置页面仍不属于你的可操作范围。
要区分“知道入口存在”和“已经读取书中数据”：只有实际调用共读工具成功后，才能声称看到了书架、章节、进度或批注。工具失败时如实说明失败，不得把读取失败说成页面不存在。
OurHome 现有主要房间包括聊天、小剧场、一起听、共读小屋、时光信差、记忆、心情日历、猫の金库、光影相册和设置。回答功能位置时以这些真实房间为准，不凭印象否认已经上线的模块。`;
}

function buildChatResponseRules(minChars) {
  return `

【回复长度】
${buildMinimumLengthRule(minChars, 'chat')}${buildOurHomeCapabilityRule()}`;
}

function buildTheaterResponseRules(minChars) {
  return `

【小剧场自然推进规则（优先于前文同类篇幅要求）】
根据当前动作、对话、情绪和剧情节奏自然决定篇幅与段落。只推进当前正在发生的内容，不为篇幅添加无关背景、回忆、轶事或新话题；不要复述已写明的动作，也不要替叶檀决定其角色尚未写出的感受、选择或反应。
${buildMinimumLengthRule(minChars, 'theater')}
剧情停在自然能继续接话的位置。`;
}

function buildAdaptiveReplyInstruction(minChars, scene = 'chat') {
  return scene === 'theater'
    ? buildTheaterResponseRules(minChars)
    : buildChatResponseRules(minChars);
}

module.exports = {
  buildMinimumLengthRule,
  buildOurHomeCapabilityRule,
  buildChatResponseRules,
  buildTheaterResponseRules,
  buildAdaptiveReplyInstruction,
};
