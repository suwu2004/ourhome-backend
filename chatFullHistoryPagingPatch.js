'use strict';

const {
  isFullVisibleChatHistoryQuery,
  fetchAllChatHistoryRows,
} = require('./chatFullHistoryPaging');

const previousFetch = globalThis.fetch;

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function chatFullHistoryPagingFetch(input, init = {}) {
    if (!isFullVisibleChatHistoryQuery(input, init)) return previousFetch(input, init);
    try {
      const response = await fetchAllChatHistoryRows(previousFetch, input, init);
      const pages = Number(response?.headers?.get?.('x-ourhome-chat-pages')) || 0;
      const rows = Number(response?.headers?.get?.('x-ourhome-chat-rows')) || 0;
      if (pages > 1) console.info(`[chat:paging] loaded ${rows || '?'} full-history rows across ${pages} pages`);
      return response;
    } catch (error) {
      console.warn('[chat:paging] full-history paging skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function chatFullPagingHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, chat_full_history_loading: 'paged-full-history-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[chat:paging] health marker unavailable:', error.message);
}

module.exports = { isFullVisibleChatHistoryQuery, fetchAllChatHistoryRows };
