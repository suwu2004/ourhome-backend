'use strict';

// Render starts the service with `node server.js`. Keep every runtime compatibility
// layer on this one path so direct Render startup and `npm start` behave the same.
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
// Install the dormant R2 mirror before any runtime creates a protected upload
// client. Without explicit Cloudflare credentials this patch is a no-op.
require('./r2ShadowPatch');
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
// Ordinary chat photos are disposable after 30 days unless another durable feature
// (photo memories, avatars/backgrounds, favorites or Toybox) still references them.
// This is storage maintenance only and never calls an AI provider.
require('./photoRetentionPatch');

// The rolling ledger runs after the cost guards. Its default path is local-first;
// if a paid ledger model is explicitly enabled later, it is still subject to the
// global non-Chat budget policy and appears in the audit log.
require('./contextLedgerPatch');
// Historical summaries and open-thread notes are background only. The final user
// entry in the provider message array always owns the current turn.
require('./chatCurrentTurnGuardPatch');

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

console.log('[runtime:bootstrap] theater memory, memory, token, native thinking, api audit, non-chat budget, local maintenance, R2 shadow storage, Render fallback front door, diary-summary isolation, zero-cost room knock, resilient Luze learning, bounded helper timeouts, photo retention, context ledger, current-turn guard, autonomy, persona cleanup, vault tool economy, private uploads, toy bear cloud persistence, Luze private learning room, Luze autonomy settings and intimacy patches loaded');

try {
  const express = require('express');
  const { r2ShadowStatus } = require('./r2ShadowStorage');
  const originalJson = express.response.json;
  express.response.json = function runtimeBootstrapJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = {
        ...body,
        runtime_bootstrap: 'direct-server-start-v2-cost-guard',
        toybox: 'toy-bear-gomoku-v4',
        toybox_cloud_history: 'drawing-auto-save-v1',
        toybox_stale_cleanup: 'one-hour-user-rounds-v1',
        luze_private_room: body.luze_private_room || 'private-learning-room-v1',
        luze_autonomy: body.luze_autonomy || 'chat-room-access-v1',
        luze_room_knock: 'local-zero-api-v1',
        luze_learning_resilience: 'long-timeout-local-fallback-v1',
        runtime_timeout_guard: 'single-call-timeouts-v2-helper-caps',
        memory_journal: body.memory_journal || 'local-semantic-summary-v2',
        upload_privacy: 'main-client-private-guard-v1',
        photo_retention: 'chat-images-30d-auto-clean-v1',
        storage_egress: '24h-signed-30d-cache-v1',
        storage_shadow: `cloudflare-r2-${r2ShadowStatus()}-v1`,
        render_frontdoor: `home-${renderFrontdoorPatch.renderFrontdoorStatus()}-v2`,
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[runtime:bootstrap] health marker unavailable:', error.message);
}
