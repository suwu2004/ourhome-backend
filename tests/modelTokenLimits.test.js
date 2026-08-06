const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  STANDARD_OUTPUT_TOKEN_CAP,
  EXTENDED_OUTPUT_TOKEN_CAP,
  outputTokenCapForModel,
  clampRequestedOutputTokens,
} = require('../modelTokenLimits');

test('standard Claude/Kiro routes use a 32K output ceiling', () => {
  assert.equal(outputTokenCapForModel('[C1]claude-opus-4-6-thinking'), STANDARD_OUTPUT_TOKEN_CAP);
  assert.equal(outputTokenCapForModel('[N]claude-opus-4-6'), STANDARD_OUTPUT_TOKEN_CAP);
  assert.equal(outputTokenCapForModel('[B]claude-opus-4-5'), STANDARD_OUTPUT_TOKEN_CAP);
});

test('PX and CX routes may use the advertised 64K output ceiling', () => {
  assert.equal(outputTokenCapForModel('[PX]claude-opus-4-6'), EXTENDED_OUTPUT_TOKEN_CAP);
  assert.equal(outputTokenCapForModel('[CX]claude-opus-4-6-thinking'), EXTENDED_OUTPUT_TOKEN_CAP);
});

test('requested output is raised by settings but never exceeds model capability', () => {
  assert.equal(clampRequestedOutputTokens('[B]claude-opus-4-5', 64_000), 32_000);
  assert.equal(clampRequestedOutputTokens('[PX]claude-opus-4-6', 64_000), 64_000);
  assert.equal(clampRequestedOutputTokens('[CX]claude-opus-4-6', 80_000), 64_000);
  assert.equal(clampRequestedOutputTokens('[C]claude-opus-4-6', 10_000), 10_000);
});

test('output token guard loads before the thinking transport', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(pkg.scripts.start, /modelTokenLimitPatch\.js.*thinkingTransportPatch\.js/);
});
