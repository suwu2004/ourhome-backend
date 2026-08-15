const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MEMORY_TIERS,
  ACTIVE_MEMORY_TIERS,
  isMemoryTableRead,
  addActiveMemoryFilters,
  filteredMemoryInput,
  layerLabel,
} = require('../memoryLayers');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260806153000_layered_memory_system.sql'),
  'utf8',
);
const expiredStatusMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260813082000_allow_expired_memory_marks.sql'),
  'utf8',
);
const memoryPatch = fs.readFileSync(path.join(__dirname, '..', 'memoryLayerPatch.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('记忆层级固定为临时、阶段、核心和归档', () => {
  assert.deepEqual(MEMORY_TIERS, ['temporary', 'episodic', 'core', 'archived']);
  assert.deepEqual(ACTIVE_MEMORY_TIERS, ['temporary', 'episodic', 'core']);
  assert.equal(layerLabel('core'), '核心记忆');
  assert.equal(layerLabel('temporary'), '临时记忆');
  assert.equal(layerLabel('episodic'), '阶段记忆');
});

test('普通 memories 查询会排除归档与已过期内容', () => {
  const source = 'https://example.supabase.co/rest/v1/memories?select=*&order=weight.desc&limit=200';
  assert.equal(isMemoryTableRead(source, { method: 'GET' }), true);
  const filtered = new URL(addActiveMemoryFilters(source, new Date('2026-08-06T15:30:00.000Z')));
  assert.equal(filtered.searchParams.get('memory_tier'), 'neq.archived');
  assert.equal(filtered.searchParams.get('or'), '(expires_at.is.null,expires_at.gt.2026-08-06T15:30:00.000Z)');
});

test('写入、RPC 与其他表请求不会被记忆读取过滤器改写', () => {
  const insertUrl = 'https://example.supabase.co/rest/v1/memories';
  assert.equal(isMemoryTableRead(insertUrl, { method: 'POST' }), false);
  assert.equal(filteredMemoryInput(insertUrl, { method: 'POST' }), insertUrl);

  const rpcUrl = 'https://example.supabase.co/rest/v1/rpc/ourhome_consolidate_memory_layers';
  assert.equal(isMemoryTableRead(rpcUrl, { method: 'POST' }), false);
});

test('已有查询条件不会被重复覆盖', () => {
  const source = 'https://example.supabase.co/rest/v1/memories?select=*&memory_tier=eq.core&or=(expires_at.is.null,expires_at.gt.2026-08-01T00%3A00%3A00Z)';
  const filtered = new URL(addActiveMemoryFilters(source, new Date('2026-08-06T15:30:00.000Z')));
  assert.equal(filtered.searchParams.get('memory_tier'), 'eq.core');
  assert.equal(filtered.searchParams.getAll('or').length, 1);
});

test('迁移保留旧记忆并提供提炼、过期和审计机制', () => {
  assert.match(migration, /memory_tier text not null default 'episodic'/);
  assert.match(migration, /memory_kind text not null default 'general'/);
  assert.match(migration, /reinforcement_count integer not null default 0/);
  assert.match(migration, /memory_consolidations/);
  assert.match(migration, /ourhome_consolidate_memory_layers/);
  assert.match(migration, /memory_tier = 'core'/);
  assert.match(migration, /memory_tier = 'archived'/);
  assert.match(migration, /status = 'expired'/);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.memories/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.memory_marks/i);
});

test('记忆标记约束接受后台整理使用的 expired 状态', () => {
  assert.match(expiredStatusMigration, /memory_marks_status_check/);
  assert.match(expiredStatusMigration, /'expired'/);
  assert.doesNotMatch(expiredStatusMigration, /delete\s+from\s+public\.memory_marks/i);
});

test('自动临时记忆超过 72 小时工作窗口后只归档不删除', () => {
  assert.match(memoryPatch, /archiveStaleWorkingMemory/);
  assert.match(memoryPatch, /updated_at.*lt\.\$\{cutoff\}/s);
  assert.match(memoryPatch, /metadata\?\.assistant_message_id/);
  assert.match(memoryPatch, /status: 'archived'/);
  assert.match(memoryPatch, /should_continue: false/);
  assert.match(memoryPatch, /working_memory_lifecycle: 'auto-archive-after-72h-v1'/);
  assert.doesNotMatch(memoryPatch, /DELETE[^\n]*memory_marks/i);
});

test('生产启动先保护 Chat 幂等，再以 402 熔断保护 Supabase/Neon，最后加载记忆、token、原生思考、审计、省钱和检索守卫', () => {
  assert.equal(
    packageJson.scripts.start,
    'node -r ./chatIdempotencyPatch.js -r ./supabaseQuotaCircuitPatch.js -r ./neonFailoverFetchPatch.js -r ./memoryLayerPatch.js -r ./modelTokenLimitPatch.js -r ./thinkingTransportPatch.js -r ./apiUsageAuditPatch.js -r ./nonChatBudgetPatch.js -r ./backgroundAiCostGuardPatch.js -r ./theaterMemoryEconomyPatch.js -r ./chatToolEconomyPatch.js -r ./chatHistorySearchResiliencePatch.js -r ./theaterMessagePagingPatch.js server.js',
  );
});
