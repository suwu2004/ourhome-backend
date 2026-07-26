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

test('MCP 工具进入模型前会修复 Schema，并在连接测试中返回诊断', async () => {
  const previousFetch = global.fetch;
  const remoteTools = [{
    name: 'tavily_search',
    description: 'Search the web',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        exact_match: { description: 'Exact matches only', default: false },
      },
      required: ['query'],
    },
  }];
  global.fetch = async (url, options) => {
    const request = JSON.parse(options.body);
    const results = {
      initialize: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'test', version: '1' } },
      'tools/list': { tools: remoteTools },
    };
    return {
      ok: true,
      status: request.method === 'notifications/initialized' ? 202 : 200,
      headers: { get: () => null },
      text: async () => request.id === undefined
        ? ''
        : JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }),
    };
  };

  try {
    const connection = {
      id: 'mcp-test-1234',
      kind: 'mcp',
      name: 'Tavily MCP',
      url: 'https://1.1.1.1/mcp',
      secret: 'saved-secret',
      enabled: true,
      config: { read_only: true },
      updated_at: '2026-07-26T00:00:00.000Z',
    };
    const manager = createIntegrationManager({
      listEnabledConnectionRuntimes: async () => [connection],
      getConnectionRuntime: async () => connection,
    });
    const dynamic = await manager.buildDynamicTools();
    const exposed = dynamic.tools.find(tool => tool.name.includes('tavily_search'));
    assert.equal(exposed.input_schema.properties.exact_match.type, 'boolean');

    const diagnosis = await manager.testConnection(connection.id);
    assert.equal(diagnosis.tool_count, 1);
    assert.ok(diagnosis.schema_repairs >= 1);
    assert.equal(diagnosis.tools[0].schema_repairs >= 1, true);
  } finally {
    global.fetch = previousFetch;
  }
});
