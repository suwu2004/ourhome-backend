const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'nonChatBudgetPatch.js'), 'utf8');

test('main Chat, Toy Bear, and Theater are exempt from the global non-Chat budget rewrite', () => {
  assert.match(source, /isMainChatRequest\(url, body\) \|\| isToyboxRequest\(body\) \|\| isTheaterRequest\(body\)/);
  assert.match(source, /Interactive Chat, Toy Bear, and Theater keep their own selected model/);
});

test('Theater requests are recognized as interactive model-controlled calls', () => {
  assert.match(source, /function isTheaterRequest\(body\)/);
  assert.match(source, /小剧场\|互动写作引擎\|剧本名/);
  assert.match(source, /if \(isTheaterRequest\(body\)\) return 'theater'/);
});

test('budget selector prefers explicit cheap hints and low-cost model families', () => {
  assert.match(source, /explicitPriceHint/);
  assert.match(source, /flash\[-_ \]\?lite\|nano/);
  assert.match(source, /haiku\|mini\|lite\|small/);
  assert.match(source, /opus\|pro\|max/);
  assert.match(source, /thinking\|reasoning/);
});

test('vision helpers only choose a cheap model that is actually vision-capable', () => {
  assert.match(source, /!vision \|\| isLikelyVisionModel\(model\)/);
  assert.match(source, /vision-reader/);
});

test('non-Chat work is blocked rather than silently falling back to an expensive active Chat model', () => {
  assert.match(source, /Never silently fall back to an expensive active Chat model/);
  assert.match(source, /ourhome_budget_model_unavailable/);
  assert.match(source, /blocked paid non-chat call/);
});

test('rewritten non-Chat calls are purpose-labelled for the API audit log', () => {
  assert.match(source, /X-OurHome-Call-Purpose/);
  assert.match(source, /non_chat_model_policy/);
  assert.match(source, /cheapest-except-chat-toybear-theater-v2/);
});
