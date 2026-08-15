'use strict';

const {
  isTheaterMessageQuery,
  fetchAllTheaterMessageRows,
} = require('./theaterMessagePaging');

const previousFetch = globalThis.fetch;

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function theaterMessagePagingFetch(input, init = {}) {
    if (!isTheaterMessageQuery(input, init)) return previousFetch(input, init);
    try {
      const response = await fetchAllTheaterMessageRows(previousFetch, input, init);
      const pages = Number(response?.headers?.get?.('x-ourhome-theater-pages')) || 0;
      const rows = Number(response?.headers?.get?.('x-ourhome-theater-rows')) || 0;
      const strategy = response?.headers?.get?.('x-ourhome-theater-strategy') || 'range';
      if (pages > 1 || strategy === 'per-book') {
        console.info(`[theater:paging] loaded ${rows || '?'} rows via ${strategy} across ${pages || '?'} request pages`);
      }
      return response;
    } catch (error) {
      console.warn('[theater:paging] full-history paging skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function theaterPagingHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = {
        ...body,
        theater_history_loading: 'per-book-paged-history-v2',
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[theater:paging] health marker unavailable:', error.message);
}

// The ordinary Chat UI already pages 240 messages at a time. This companion
// guard only protects legacy "load the whole session" paths (notably a search
// jump) so an old 1000+ message session can never hit the same Supabase cap.
require('./chatFullHistoryPagingPatch');

module.exports = { isTheaterMessageQuery, fetchAllTheaterMessageRows };
