'use strict';

// Keep every runtime compatibility layer aligned across direct `node server.js`
// startup and `npm start`. Requiring a patch again from npm preload is harmless
// because Node caches modules. Protect the outer Chat send first, then suppress
// repeated real Supabase REST 402s before the Neon fallback captures fetch.
require('./chatIdempotencyPatch');
require('./supabaseQuotaCircuitPatch');
require('./neonFailoverFetchPatch');
// Compact repeated near-identical theater facts before theaterMemoryPatch captures
// the support helpers. This keeps long scenes chronological without spending an
// extra model call just to clean duplicate memory rows.
require('./theaterMemoryFactDedupPatch');
require('./theaterMemoryPatch');
require('./memoryLayerPatch');
require('./modelTokenLimitPatch');

// Chat reasoning is native-only: no forced chain and no synthetic fallback.
require('./thinkingTransportPatch');

// Audit must sit underneath the budget guards so it records the final model that
// is actually sent to the provider. Non-Chat paid work then uses the cheapest
// suitable model, while local maintenance can stop before any paid request.
require('./apiUsageAuditPatch');
require('./nonChatBudgetPatch');
require('./backgroundAiCostGuardPatch');
// Supabase Pro is the sole live object store. Historical OSS migration modules
// remain available for supervised recovery work, but production startup never
// loads the adapter, probes Aliyun or starts a backfill timer.
// A cached Render build can occasionally contain a stale index.html beside newer
// hashed assets. Reject that incomplete shell before the front-door module resolves
// its local directory, so the safe Vercel-origin fallback can provide one coherent build.
const { guardRenderFrontend } = require('./renderFrontendIntegrityGuard');
guardRenderFrontend();
// Add a Render-hosted fallback UI before Express starts listening. The existing
// '/' health endpoint remains untouched; the browser entry is '/home'.
const renderFrontdoorPatch = require('./renderFrontdoorPatch');
// The hidden journal may maintain open-thread metadata every turn, but its local
// fallback must never turn the user-facing Happiness Diary summary into “本轮” logs.
require('./memoryJournalPresentationPatch');
// A private-room knock is only a local ritual. Intercept its old consent-shaped
// model request before it can reach the provider or the API usage audit.
require('./luzeDoorCostGuardPatch');
// Learning-note synthesis is allowed a longer transport window than small helper
// calls. Clear transient HTTP failures retry once; ambiguous timeouts fall back
// locally so a completed browsing run never vanishes without a note.
require('./luzeLearningResiliencePatch');
// A few known single-call helpers used timeouts that were shorter than healthy
// provider latency (or had no practical cap). Extend/cap only those exact calls;
// never retry them here, so this guard cannot create an extra provider charge.
require('./runtimeTimeoutGuardPatch');
// After 30 days, ordinary chat photo bytes are removed only when a durable image
// analysis already exists. Photo memories, avatars/backgrounds, favorites and
// Toybox assets are protected. The conversation keeps the analysis text.
require('./photoRetentionPatch');

// The rolling ledger runs after the cost guards. Its default path is local-first;
// if a paid ledger model is explicitly enabled later, it is still subject to the
// global non-Chat budget policy and appears in the audit log.
require('./contextLedgerPatch');
// Historical summaries and open-thread notes are background only. The final user
// entry in the provider message array always owns the current turn.
require('./chatCurrentTurnGuardPatch');
// Rules describe behavior, memories describe lived events, and lorebooks supply
// scoped world knowledge. Lorebooks are selected only at provider-call time so
// Chat and each Theater book keep independent activation contexts.
require('./lorebookPatch');

// Adjust ambiguous intimacy cues before intimacyFlowPatch captures the exports.
require('./intimacyFlowAutonomyPatch');
// Remove old response-shaping instructions that conflict with the compact
// persona-first rules stored in settings. This changes prompt wording only.
require('./chatPromptCleanupPatch');
// Exact vault account names can be resolved by the backend itself, so Chat should
// not spend another expensive model round reading the vault just to fetch IDs.
require('./chatToolEconomyPatch');
// Register the lightweight AI-backed Toy Bear routes without touching Chat history.
require('./toyboxRoutePatch');
// Add persistent game history, shared active state and Chat-linked Toy Bear access.
require('./toyboxSocialRoutePatch');
// A finished Drawing guess is a save boundary: persist freestyle drawings too,
// and attach the canvas image to an existing prompted Drawing run when possible.
require('./toyboxDrawingPersistencePatch');
// Lu Ze's own room stays outside relationship memory. It has a per-visit door pass,
// private notes/ideas/trails and a small autonomous read-only learning loop.
require('./luzePrivateRoomPatch');
// Settings may tune Lu Ze's autonomy without opening the private room itself.
require('./luzeAutonomySettingsPatch');
// Keep intimacy last: it becomes the outer transport boundary and sanitizes any
// hidden control after normal text/ledger processing but before persistence.
require('./intimacyFlowPatch');

console.log('[runtime:bootstrap] Chat idempotency, adaptive Supabase 402 circuit, Neon quota failover, theater memory dedup, theater memory, memory, token, native thinking, api audit, non-chat budget, local maintenance, Supabase Pro storage, Render fallback front door, diary-summary isolation, zero-cost room knock, resilient Luze learning, bounded helper timeouts, photo retention, context ledger, current-turn guard, scoped lorebooks, autonomy, persona cleanup, vault tool economy, private uploads, toy bear cloud persistence, Luze private learning room, Luze autonomy settings and intimacy patches loaded');

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function runtimeBootstrapJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = {
        ...body,
        runtime_bootstrap: 'direct-server-start-v4-adaptive-stability',
        chat_idempotency: 'request-id-theater-replay-v2',
        supabase_quota_circuit: 'rest-402-adaptive-v2',
        toybox: 'toy-bear-gomoku-v4',
        toybox_cloud_history: 'drawing-auto-save-v1',
        toybox_stale_cleanup: 'one-hour-user-rounds-v1',
        luze_private_room: body.luze_private_room || 'private-learning-room-v1',
        luze_autonomy: body.luze_autonomy || 'chat-room-access-v1',
        luze_room_knock: 'local-zero-api-v1',
        luze_learning_resilience: 'long-timeout-local-fallback-v1',
        runtime_timeout_guard: 'single-call-timeouts-v2-helper-caps',
        memory_journal: body.memory_journal || 'local-semantic-summary-v4-strict-working-set',
        happiness_diary: '500-900-char-v1',
        chat_prompt_cost_control: 'selective-tools-context-budget-v1',
        background_persona: 'purpose-projected-v1',
        theater_rule_injection: 'live-scoped-library-v1',
        lorebook_injection: 'scoped-keyword-budget-v1',
        calendar_day_colors: 'cloud-settings-v1',
        upload_privacy: 'main-client-private-guard-v1',
        background_recovery: 'quota-cooldown-signed-url-v2',
        neon_failover_reads: 'sql-filtered-coalesced-v4',
        neon_failover_writes: 'journal-v5-serialized-compacted-defaults',
        neon_chat_persistence: 'visible-current-turn-v1',
        neon_api_profiles: 'encrypted-secret-write-v3-normalized-wrap',
        neon_secret_wrap: 'normalized-v2-transition-v1',
        neon_replay: 'primary-probe-idempotent-v1',
        api_model_catalog: 'saved-model-fallback-v1',
        storage_failover: 'neon-object-spool-v1',
        photo_retention: 'chat-images-30d-delete-bytes-keep-analysis-v4',
        storage_egress: '24h-signed-30d-cache-v1',
        object_storage: 'supabase-pro-primary-v1',
        object_storage_migration: 'aliyun-retired-source-retained-v1',
        image_pipeline: 'sharp-0.35.3-libvips-8.18.3-v1',
        frontend_bundle: 'chat-theater-shared-rule-scopes-v4',
        render_frontdoor: `home-${renderFrontdoorPatch.renderFrontdoorStatus()}-v3-native-response`,
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[runtime:bootstrap] health marker unavailable:', error.message);
}
