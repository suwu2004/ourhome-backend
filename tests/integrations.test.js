const assert = require('node:assert/strict');
const test = require('node:test');
const { createIntegrationManager } = require('../integrations');

async function runSearch(connection, responseBody) {
  let request = null;
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify(responseBody) };
  };
  try {
    const manager = createIntegrationManager({
      listEnabledConnectionRuntimes: async () => [connection],
      getConnectionRuntime: async () => connection,
    });
    const dynamic = await manager.buildDynamicTools();
    const result = await dynamic.handlers.get('web_search')({ query: 'OurHome test', max_results: 2 });
    return { request, result };
  } finally {
    global.fetch = previousFetch;
  }
}

test('Linkup 线路使用 Linkup 请求格式并统一返回结果', async () => {
  const { request, result } = await runSearch({
    id: 'linkup',
    kind: 'web_search',
    name: 'Linkup',
    url: 'https://api.linkup.so/v1/search',
    secret: 'saved-secret',
    config: { provider: 'linkup', search_depth: 'standard' },
  }, {
    results: [{ name: 'Linkup result', url: 'https://example.com/linkup', content: 'ok' }],
  });

  assert.equal(request.url, 'https://api.linkup.so/v1/search');
  assert.equal(request.options.headers.Authorization, 'Bearer saved-secret');
  assert.equal(request.body.q, 'OurHome test');
  assert.equal(request.body.outputType, 'searchResults');
  assert.equal(result.results[0].title, 'Linkup result');
});

test('Tavily 线路继续使用 Tavily 请求格式', async () => {
  const { request, result } = await runSearch({
    id: 'tavily',
    kind: 'web_search',
    name: 'Tavily',
    url: 'https://api.tavily.com/search',
    secret: 'saved-secret',
    config: { provider: 'tavily', search_depth: 'advanced' },
  }, {
    results: [{ title: 'Tavily result', url: 'https://example.com/tavily', content: 'ok' }],
  });

  assert.equal(request.url, 'https://api.tavily.com/search');
  assert.equal(request.options.headers.Authorization, 'Bearer saved-secret');
  assert.equal(request.body.query, 'OurHome test');
  assert.equal(result.results[0].title, 'Tavily result');
});
