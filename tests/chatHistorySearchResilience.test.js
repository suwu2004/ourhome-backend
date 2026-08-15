'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fallbackMessagesSearchUrl } = require('../chatHistorySearchResiliencePatch');

test('chat-history PostgREST retry removes only optional sessions(name) embed', () => {
  const original = 'https://example.supabase.co/rest/v1/messages?select=id%2Csession_id%2Crole%2Ccontent%2Ccreated_at%2Csessions%28name%29&visible=eq.true&content=ilike.%25%E8%81%8A%E5%A4%A9%E8%AE%B0%E5%BD%95%25&order=created_at.desc&limit=8';
  const fallback = new URL(fallbackMessagesSearchUrl(original, { method: 'GET' }));
  assert.equal(fallback.pathname, '/rest/v1/messages');
  assert.equal(fallback.searchParams.get('select'), 'id,session_id,role,content,created_at');
  assert.equal(fallback.searchParams.get('visible'), 'eq.true');
  assert.equal(fallback.searchParams.get('content'), 'ilike.%聊天记录%');
});

test('unrelated Supabase reads and non-GET requests are untouched', () => {
  assert.equal(fallbackMessagesSearchUrl('https://example.supabase.co/rest/v1/memories?select=id,sessions(name)', { method: 'GET' }), null);
  assert.equal(fallbackMessagesSearchUrl('https://example.supabase.co/rest/v1/messages?select=id,sessions(name)', { method: 'POST' }), null);
  assert.equal(fallbackMessagesSearchUrl('https://example.supabase.co/rest/v1/messages?select=id,content', { method: 'GET' }), null);
});

test('npm start and runtime bootstrap both load history-search resilience', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  const bootstrap = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');
  assert.match(pkg.scripts.start, /chatHistorySearchResiliencePatch\.js/);
  assert.match(bootstrap, /require\('\.\/chatHistorySearchResiliencePatch'\)/);
});
