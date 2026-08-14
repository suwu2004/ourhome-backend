'use strict';

const support = require('./theaterMemorySupport');

const baseMergeTheaterFacts = support.mergeTheaterFacts;
const baseShouldRefreshMemory = support.shouldRefreshMemory;
const MAX_ACTIVE_FACTS = 54;
const FORCE_COMPACTION_AT = 58;

function normalizedFact(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function gramSet(value, size) {
  const text = normalizedFact(value);
  const grams = new Set();
  if (!text) return grams;
  if (text.length <= size) {
    grams.add(text);
    return grams;
  }
  for (let index = 0; index <= text.length - size; index += 1) {
    grams.add(text.slice(index, index + size));
  }
  return grams;
}

function overlapCoefficient(left, right, size) {
  const a = gramSet(left, size);
  const b = gramSet(right, size);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  for (const gram of smaller) if (larger.has(gram)) shared += 1;
  return shared / Math.max(1, smaller.size);
}

function sharedGramCount(left, right, size) {
  const a = gramSet(left, size);
  const b = gramSet(right, size);
  let shared = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  for (const gram of smaller) if (larger.has(gram)) shared += 1;
  return shared;
}

function isNearDuplicateFact(left, right, distance = Number.POSITIVE_INFINITY) {
  const a = normalizedFact(left);
  const b = normalizedFact(right);
  if (Math.min(a.length, b.length) < 16) return false;
  if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 14) return true;

  const bigramOverlap = overlapCoefficient(a, b, 2);
  const sharedFourGrams = sharedGramCount(a, b, 4);

  // High overlap is safe anywhere in the memory list. A looser threshold is only
  // allowed for nearby facts, where repeated model summaries commonly describe
  // the same scene twice with slightly different wording.
  if (bigramOverlap >= 0.56) return true;
  if (bigramOverlap >= 0.30 && sharedFourGrams >= 6) return true;
  return distance <= 6 && bigramOverlap >= 0.22 && sharedFourGrams >= 4;
}

function richerFact(previous, current) {
  const oldText = String(previous || '').trim();
  const newText = String(current || '').trim();
  if (!oldText) return newText;
  if (!newText) return oldText;
  // Prefer the newer wording when it carries roughly the same amount of detail;
  // otherwise keep the richer old summary but move it to the newer timeline slot.
  return newText.length >= oldText.length * 0.82 ? newText : oldText;
}

function compactTheaterFacts(facts = [], limit = MAX_ACTIVE_FACTS) {
  const rows = Array.isArray(facts) ? facts.filter(Boolean) : [];
  const compacted = [];

  for (const raw of rows) {
    const current = String(raw || '').trim();
    if (!current) continue;

    let duplicateIndex = -1;
    const earliest = Math.max(0, compacted.length - 12);
    for (let index = compacted.length - 1; index >= earliest; index -= 1) {
      const distance = compacted.length - index;
      if (isNearDuplicateFact(compacted[index], current, distance)) {
        duplicateIndex = index;
        break;
      }
    }

    if (duplicateIndex >= 0) {
      const replacement = richerFact(compacted[duplicateIndex], current);
      compacted.splice(duplicateIndex, 1);
      compacted.push(replacement);
    } else {
      compacted.push(current);
    }
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || MAX_ACTIVE_FACTS, MAX_ACTIVE_FACTS));
  return compacted.slice(Math.max(0, compacted.length - safeLimit));
}

function patchedMergeTheaterFacts(previous = [], next = [], limit = 60) {
  const generousLimit = Math.max(120, (Number(limit) || 60) * 2);
  const merged = baseMergeTheaterFacts(previous, next, generousLimit);
  return compactTheaterFacts(merged, limit);
}

function patchedShouldRefreshMemory(memoryValue, latestUserText = '', replyText = '') {
  const factCount = Array.isArray(memoryValue?.plot_facts) ? memoryValue.plot_facts.length : 0;
  if (factCount >= FORCE_COMPACTION_AT) return true;
  return baseShouldRefreshMemory(memoryValue, latestUserText, replyText);
}

support.mergeTheaterFacts = patchedMergeTheaterFacts;
support.shouldRefreshMemory = patchedShouldRefreshMemory;

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function theaterMemoryDedupHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, theater_memory_dedup: 'nearby-event-compaction-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[theater:memory:dedup] health marker unavailable:', error.message);
}

module.exports = {
  MAX_ACTIVE_FACTS,
  FORCE_COMPACTION_AT,
  normalizedFact,
  overlapCoefficient,
  sharedGramCount,
  isNearDuplicateFact,
  compactTheaterFacts,
  patchedMergeTheaterFacts,
  patchedShouldRefreshMemory,
};
