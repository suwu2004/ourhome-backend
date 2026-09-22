// 跑一轮"可能带工具调用"的对话，直到陆泽不再调用工具为止——
// 关键点：每一轮都要重新把工具列表带上，不然他读完东西之后想接着写，会发现手里没工具了
async function runToolLoop({ settings, modelName, maxTokens, systemPrompt, messages, thinkingParam, toolsParam, toolHandlers, gemini, purpose }) {
  const MAX_TOOL_ROUNDS = 4;
  let currentMessages = messages;
  const textToolBridge = buildTextToolBridge(toolsParam);
  let textBridgeEnabled = Boolean(gemini || !/claude/i.test(String(modelName || '')));
  let nativeToolsEnabled = Array.isArray(toolsParam) && toolsParam.length > 0;

  const callRound = async () => {
    const compatibleSystemPrompt = systemPrompt + (textBridgeEnabled ? textToolBridge : '');
    try {
      return await callClaude({
        settings, model: modelName, maxTokens,
        system: compatibleSystemPrompt,
        messages: currentMessages,
        thinking: thinkingParam,
        tools: nativeToolsEnabled ? toolsParam : undefined,
        purpose,
      });
    } catch (error) {
      if (!nativeToolsEnabled || !isToolCompatibilityError(error)) throw error;
      // 有些中转站能正常聊天，却拒绝 Claude 格式的 tools 字段。
      // 只在明确的格式不兼容错误下关闭原生工具，并改用受控文字协议重试。
      nativeToolsEnabled = false;
      textBridgeEnabled = true;
      return callClaude({
        settings, model: modelName, maxTokens,
        system: systemPrompt + textToolBridge,
        messages: currentMessages,
        thinking: thinkingParam,
        purpose,
      });
    }
  };

  let result = await callRound();
  let totalInputTokens = result.usage?.input_tokens || 0;
  let totalOutputTokens = result.usage?.output_tokens || 0;
  let actionsPerformed = [];
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    const nativeToolBlocks = (result.content || []).filter(block => block.type === 'tool_use');
    const textToolCalls = nativeToolBlocks.length ? [] : parseTextToolCalls(result);
    if (!nativeToolBlocks.length && !textToolCalls.length) break;
    rounds++;
    const requestedTools = nativeToolBlocks.length
      ? nativeToolBlocks.map(block => ({ name: block.name, input: block.input || {}, id: block.id }))
      : textToolCalls;
    const executed = [];
    let mailActionExecuted = false;
    for (const request of requestedTools) {
      let actionResult;
      try {
        if (toolHandlers?.has(request.name)) {
          const externalResult = await toolHandlers.get(request.name)(request.input || {});
          actionResult = { ok: true, ...externalResult };
        } else if (ACTION_TOOL_NAMES.has(request.name)) {
          actionResult = await executeActionTool(request.name, request.input || {});
        } else {
          actionResult = { ok: false, error: '这个工具不在 OurHome 的许可列表中。' };
        }
      } catch (toolError) {
        actionResult = { ok: false, error: toolError.message };
      }
      actionsPerformed.push({ name: request.name, input: request.input, result: actionResult });
      executed.push({ ...request, result: actionResult });
      if (request.name === 'send_agentmail_message' || request.name === 'reply_agentmail_message') {
        mailActionExecuted = true;
      }
    }

    if (nativeToolBlocks.length) {
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: result.content },
        {
          role: 'user',
          content: executed.map(item => ({
            type: 'tool_result',
            tool_use_id: item.id,
            content: JSON.stringify(item.result),
          })),
        },
      ];
    } else {
      textBridgeEnabled = true;
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: result.content },
        {
          role: 'user',
          content: `<ourhome_tool_result>${JSON.stringify(executed.map(item => ({ name: item.name, result: item.result })))}</ourhome_tool_result>\n请依据真实结果继续回答；需要下一项操作时再请求一个工具。`,
        },
      ];
    }

    result = await callRound();
    totalInputTokens += result.usage?.input_tokens || 0;
    totalOutputTokens += result.usage?.output_tokens || 0;
  }

  return { result, totalInputTokens, totalOutputTokens, actionsPerformed };
}
