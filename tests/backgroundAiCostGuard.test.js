const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const guard = fs.readFileSync(path.resolve(__dirname, '..', 'backgroundAiCostGuardPatch.js'), 'utf8');
const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const {
  addModelMemoryRules,
  localMemoryJournal,
  localOnlyEnabled,
  resolveMemoryJournalModel,
  shouldSpendMemoryJournalCall,
  summarizeTurn,
  shouldContinueWorkingMemory,
} = require('../backgroundAiCostGuardPatch');

function journalBody(userText, assistantText, existing = '无') {
  return {
    model: 'test-model',
    messages: [{
      role: 'user',
      content: `请为 OurHome 的记忆日志分析刚刚这一轮聊天。你不是在回复叶檀，而是在做后台记录。\n\n【今天已有摘要】\n${existing}\n\n【未收尾话题】\n无\n\n【刚刚这一轮】\n叶檀：${userText}\n陆泽：${assistantText}\n\n请只输出 JSON，不要解释。`,
    }],
  };
}

test('memory journal request still starts from the configured or active Chat model', () => {
  assert.match(server, /MEMORY_JOURNAL_MODEL\s*\|\|\s*settings\?\.memory_journal_model\s*\|\|\s*settings\?\.selected_model/);
  assert.equal(resolveMemoryJournalModel({ model: 'active-chat-model' }, {}), 'active-chat-model');
  assert.equal(resolveMemoryJournalModel({ model: 'active-chat-model' }, { MEMORY_JOURNAL_MODEL: 'memory-model' }), 'memory-model');
});

test('real model owns ambiguous memory decisions while obvious non-memory turns are free', () => {
  assert.equal(localOnlyEnabled({}), false);
  assert.equal(localOnlyEnabled({ MEMORY_JOURNAL_LOCAL_ONLY: 'false' }), false);
  assert.equal(localOnlyEnabled({ MEMORY_JOURNAL_LOCAL_ONLY: '1' }), true);
  assert.match(guard, /model judgement requested/);
  assert.match(guard, /obvious non-memory turn skipped locally/);
  assert.match(guard, /X-OurHome-Call-Purpose[^\n]*memory-journal/);
});

test('casual chat never becomes a paid memory judgement because the assistant mentioned memory words', () => {
  const body = journalBody(
    '🥺🥺🥺 老公我饿了',
    '搜索工具刚才出错了，等工具好了我再找。你告诉我一次我以后会记得。现在先吃饭。',
  );
  assert.equal(shouldSpendMemoryJournalCall(body), false);
  assert.equal(shouldSpendMemoryJournalCall(journalBody('宝宝抱抱，我想你了', '抱紧你。')), false);
  assert.equal(shouldSpendMemoryJournalCall(journalBody('你不能搜索聊天记录嘛🥺', '我去翻一下。')), false);
});

test('durable changes and explicit preferences are allowed through to model judgement', () => {
  assert.equal(shouldSpendMemoryJournalCall(journalBody('我最近换工作了，现在主要做 AI 漫剧。', '知道了。')), true);
  assert.equal(shouldSpendMemoryJournalCall(journalBody('我不喜欢你用汇报式语气，以后自然一点。', '好。')), true);
  assert.equal(shouldSpendMemoryJournalCall(journalBody('OurHome 以后世界书默认关闭，导入后让我自己选。', '记住这个规则。')), true);
  assert.equal(shouldSpendMemoryJournalCall(journalBody('我明天下午要去面试，别忘了。', '好。')), true);
});

test('model prompt makes storage explicit, sparse, and update-oriented', () => {
  const body = addModelMemoryRules(journalBody('我不喜欢这种语气，以后别这样。', '好，我改。'));
  const text = body.messages[0].content;
  assert.match(text, /should_store/);
  assert.match(text, /默认 should_store=false/);
  assert.match(text, /同一事实/);
  assert.match(text, /没有实质变化/);
  assert.match(text, /沿用稳定、简短、可复用的 topic/);
  assert.match(text, /不需要用户手动升级|长期记忆仍由 long_memory 独立判断/);
});

test('local fallback does not turn emoji or affection into copied working memory', () => {
  const result = localMemoryJournal(journalBody('🥲🥲🥲🥲', '（抱抱你）过来。'));
  assert.equal(result.mark.should_continue, false);
  assert.equal(result.mark.should_store, false);
  assert.equal(result.mark.summary, '');
  assert.equal(result.mark.topic, '');

  const affectionate = localMemoryJournal(journalBody('（亲亲你的脸）哥哥我好喜欢你🥺🥺', '我也很喜欢你，抱紧。'));
  assert.equal(affectionate.mark.should_continue, false);
  assert.equal(affectionate.mark.should_store, false);
  assert.equal(affectionate.mark.summary, '');
});

test('local fallback paraphrases a meaningful turn instead of copying the user sentence', () => {
  const raw = 'I love you。小熊还会说这个好不好！！！不过你为啥会搜日本音乐🎵';
  const result = localMemoryJournal(journalBody(raw, '小熊当然可以说。至于日本音乐，是我自己出去逛的时候碰到的。'));
  assert.equal(result.mark.should_continue, false);
  assert.notEqual(result.daily_summary.summary, raw);
  assert.doesNotMatch(result.daily_summary.summary, /I love you。小熊还会说这个好不好/);
  assert.match(result.daily_summary.summary, /玩具熊/);
  assert.match(result.daily_summary.summary, /音乐/);
});

test('unfinished project work remains a safe local fallback working-memory mark', () => {
  const user = '宝宝你先把 API 调用记录放到模型上面，改完上线，我待会手机看。';
  const assistant = '好，我现在改，接下来跑 CI，再上线给你看。';
  const result = localMemoryJournal(journalBody(user, assistant));
  assert.equal(shouldContinueWorkingMemory(user, assistant), true);
  assert.equal(result.mark.should_continue, true);
  assert.equal(result.mark.should_store, true);
  assert.equal(result.mark.topic, 'API 与模型');
  assert.match(result.mark.summary, /OurHome|API/);
  assert.doesNotMatch(result.mark.summary, /宝宝你先把/);
  assert.deepEqual(result.daily_summary.open_threads, [result.mark.summary]);
});

test('completed one-turn task does not linger in the explicit local fallback', () => {
  const user = '老公，洗面奶记账了吗？';
  const assistant = '已经记好了，刚刚那笔已经进金库了。';
  assert.equal(shouldContinueWorkingMemory(user, assistant), false);
  const result = localMemoryJournal(journalBody(user, assistant));
  assert.equal(result.mark.should_continue, false);
  assert.equal(result.mark.should_store, false);
  assert.equal(result.mark.summary, '');
  assert.match(summarizeTurn(user, assistant), /记账/);
});

test('provider memory journal calls are purpose-labelled for the API console', () => {
  assert.match(guard, /headers\.set\('X-OurHome-Call-Purpose', 'memory-journal'\)/);
  assert.match(guard, /body: JSON\.stringify\(\{ \.\.\.preparedBody, model \}\)/);
});
