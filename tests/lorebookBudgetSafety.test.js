'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  approximateTokens,
  selectLorebookEntries,
  truncateCompiledContext,
} = require('../lorebookStore');

test('an oversized first worldbook entry is clipped to the configured token budget', () => {
  const originalContent = '这是一条非常长的世界书设定。'.repeat(300);
  const entry = {
    id: 'oversized',
    name: '完整设定',
    content: originalContent,
    constant: true,
    enabled: true,
    priority: 10,
    insertion_order: 0,
  };

  const selected = selectLorebookEntries({
    scan_depth: 12,
    token_budget: 128,
    recursive_scanning: false,
  }, [entry], ['你好']);

  assert.equal(selected.length, 1);
  assert.ok(approximateTokens(`${selected[0].name}\n${selected[0].content}`) <= 128);
  assert.match(selected[0].content, /本条世界书已按本轮预算截断/);
  assert.equal(entry.content, originalContent, 'selection must never mutate stored worldbook content');
});

test('small worldbook entries remain byte-for-byte unchanged', () => {
  const entry = {
    id: 'small',
    name: '地点',
    content: '花园在东侧。',
    constant: true,
    enabled: true,
    priority: 1,
    insertion_order: 0,
  };

  const selected = selectLorebookEntries({
    scan_depth: 12,
    token_budget: 2000,
    recursive_scanning: false,
  }, [entry], ['花园']);

  assert.equal(selected.length, 1);
  assert.equal(selected[0], entry);
  assert.equal(selected[0].content, '花园在东侧。');
});

test('global worldbook truncation is explicit and never silently hard-cuts the context', () => {
  const context = `${'第一段设定。'.repeat(120)}\n\n${'第二段设定。'.repeat(120)}`;
  const truncated = truncateCompiledContext(context, 600);

  assert.ok(truncated.length <= 600);
  assert.match(truncated, /世界书上下文达到本轮总上限）$/);
});
