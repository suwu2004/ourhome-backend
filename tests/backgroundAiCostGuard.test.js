const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const guard = fs.readFileSync(path.resolve(__dirname, '..', 'backgroundAiCostGuardPatch.js'), 'utf8');
const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const { localMemoryJournal, summarizeTurn, shouldContinueWorkingMemory } = require('../backgroundAiCostGuardPatch');

function journalBody(userText, assistantText, existing = '无') {
  return {
    model: 'test-model',
    messages: [{
      role: 'user',
      content: `请为 OurHome 的记忆日志分析刚刚这一轮聊天。你不是在回复叶檀，而是在做后台记录。\n\n【今天已有摘要】\n${existing}\n\n【未收尾话题】\n无\n\n【刚刚这一轮】\n叶檀：${userText}\n陆泽：${assistantText}\n\n请只输出 JSON，不要解释。`,
    }],
  };
}

test('memory journal previously fell back to the active Chat model', () => {
  assert.match(server, /MEMORY_JOURNAL_MODEL\s*\|\|\s*settings\?\.memory_journal_model\s*\|\|\s*settings\?\.selected_model/);
});

test('background cost guard handles memory journal locally unless explicitly configured', () => {
  assert.match(guard, /请为 OurHome 的记忆日志分析刚刚这一轮聊天/);
  assert.match(guard, /process\.env\.MEMORY_JOURNAL_MODEL/);
  assert.match(guard, /if \(!dedicatedModel\)/);
  assert.match(guard, /localAnthropicResponse\(localMemoryJournal\(body\)\)/);
  assert.match(guard, /usage: \{ input_tokens: 0, output_tokens: 0 \}/);
});

test('local memory journal does not turn emoji or affection into copied working memory', () => {
  const result = localMemoryJournal(journalBody('🥲🥲🥲🥲', '（抱抱你）过来。'));
  assert.equal(result.mark.should_continue, false);
  assert.equal(result.mark.summary, '');
  assert.equal(result.mark.topic, '');

  const affectionate = localMemoryJournal(journalBody('（亲亲你的脸）哥哥我好喜欢你🥺🥺', '我也很喜欢你，抱紧。'));
  assert.equal(affectionate.mark.should_continue, false);
  assert.equal(affectionate.mark.summary, '');
});

test('local memory journal paraphrases a meaningful turn instead of copying the user sentence', () => {
  const raw = 'I love you。小熊还会说这个好不好！！！不过你为啥会搜日本音乐🎵';
  const result = localMemoryJournal(journalBody(raw, '小熊当然可以说。至于日本音乐，是我自己出去逛的时候碰到的。'));
  assert.equal(result.mark.should_continue, false);
  assert.notEqual(result.daily_summary.summary, raw);
  assert.doesNotMatch(result.daily_summary.summary, /I love you。小熊还会说这个好不好/);
  assert.match(result.daily_summary.summary, /玩具熊/);
  assert.match(result.daily_summary.summary, /音乐/);
});

test('unfinished project work becomes a concise semantic working-memory mark', () => {
  const user = '宝宝你先把 API 调用记录放到模型上面，改完上线，我待会手机看。';
  const assistant = '好，我现在改，接下来跑 CI，再上线给你看。';
  const result = localMemoryJournal(journalBody(user, assistant));
  assert.equal(shouldContinueWorkingMemory(user, assistant), true);
  assert.equal(result.mark.should_continue, true);
  assert.equal(result.mark.topic, 'API 与模型');
  assert.match(result.mark.summary, /OurHome|API/);
  assert.doesNotMatch(result.mark.summary, /宝宝你先把/);
  assert.deepEqual(result.daily_summary.open_threads, [result.mark.summary]);
});

test('completed one-turn task does not linger as working memory', () => {
  const user = '老公，洗面奶记账了吗？';
  const assistant = '已经记好了，刚刚那笔已经进金库了。';
  assert.equal(shouldContinueWorkingMemory(user, assistant), false);
  const result = localMemoryJournal(journalBody(user, assistant));
  assert.equal(result.mark.should_continue, false);
  assert.equal(result.mark.summary, '');
  assert.match(summarizeTurn(user, assistant), /记账/);
});

test('explicit memory journal provider calls are purpose-labelled', () => {
  assert.match(guard, /X-OurHome-Call-Purpose[^\n]*memory-journal/);
  assert.match(guard, /body: JSON\.stringify\(nextBody\)/);
});
