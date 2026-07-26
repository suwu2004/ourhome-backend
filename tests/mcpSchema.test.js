const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMcpInputSchema, mergeMcpSchemaDiagnostics } = require('../mcpSchema');

test('缺失 type 的 MCP 参数会按默认值补全，并清理不兼容结构', () => {
  const source = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      exact_match: { description: 'Only exact matches', default: false },
      domains: { type: 'array', items: { enum: ['a.example', 'b.example'] } },
      mode: { anyOf: [{ type: 'string', enum: ['basic', 'advanced'] }, { type: 'null' }] },
    },
    required: ['query', 'ghost'],
  };
  const before = structuredClone(source);
  const { schema, diagnostics } = normalizeMcpInputSchema(source);

  assert.deepEqual(source, before);
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.exact_match.type, 'boolean');
  assert.equal(schema.properties.exact_match.default, false);
  assert.equal(schema.properties.domains.items.type, 'string');
  assert.equal(schema.properties.mode.type, 'string');
  assert.deepEqual(schema.required, ['query']);
  assert.equal('$schema' in schema, false);
  assert.ok(diagnostics.inferredTypes >= 2);
  assert.ok(diagnostics.simplifiedUnions >= 1);
  assert.equal(diagnostics.removedRequired, 1);
  assert.ok(diagnostics.repairs >= 4);
});

test('嵌套对象、数组和类型数组会递归变成模型可用的 Schema', () => {
  const { schema, diagnostics } = normalizeMcpInputSchema({
    type: 'OBJECT',
    properties: {
      filters: {
        properties: {
          published: { type: ['string', 'null'], format: 'date' },
          limit: { default: 5, minimum: 1, maximum: 20 },
        },
        required: ['published', 'limit'],
      },
      rows: { type: 'array' },
    },
  });

  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.filters.type, 'object');
  assert.equal(schema.properties.filters.properties.published.type, 'string');
  assert.equal(schema.properties.filters.properties.limit.type, 'integer');
  assert.equal(schema.properties.rows.items.type, 'string');
  assert.ok(diagnostics.normalizedTypes >= 1);
  assert.ok(diagnostics.simplifiedUnions >= 1);
  assert.ok(diagnostics.fallbackSchemas >= 1);
});

test('诊断统计可以安全汇总多个 MCP 工具', () => {
  const first = normalizeMcpInputSchema({ type: 'object', properties: { enabled: { default: true } } }).diagnostics;
  const second = normalizeMcpInputSchema({ type: 'object', properties: { tags: { type: 'array' } } }).diagnostics;
  const merged = mergeMcpSchemaDiagnostics([first, second]);

  assert.equal(merged.repairs, first.repairs + second.repairs);
  assert.equal(merged.inferredTypes, first.inferredTypes + second.inferredTypes);
  assert.ok(merged.notes.length > 0);
});
