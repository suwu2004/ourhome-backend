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
      const pages = response?.headers?.get?.('x-ourhome-theater-pages');
      if (pages && Number(pages) > 1) {
        console.info(`[theater:paging] loaded full history across ${pages} pages`);
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
      body = { ...body, theater_history_loading: 'paged-full-history-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[theater:paging] health marker unavailable:', error.message);
}

module.exports = { isTheaterMessageQuery, fetchAllTheaterMessageRows };
