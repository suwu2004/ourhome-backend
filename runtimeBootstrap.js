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
// A private-room knock is only a local ritual. Intercept its old consent-shaped
// model request before it can reach the provider or the API usage audit.
require('./luzeDoorCostGuardPatch');

// The rolling ledger runs after the cost guards. Its default path is local-first;
// if a paid ledger model is explicitly enabled later, it is still subject to the
// global non-Chat budget policy and appears in the audit log.
require('./contextLedgerPatch');

// Adjust ambiguous intimacy cues before intimacyFlowPatch captures the exports.
require('./intimacyFlowAutonomyPatch');
// Remove old response-shaping instructions that conflict with the compact
// persona-first rules stored in settings. This changes prompt wording only.
require('./chatPromptCleanupPatch');
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

console.log('[runtime:bootstrap] theater memory, memory, token, native thinking, api audit, non-chat budget, local maintenance, zero-cost room knock, context ledger, autonomy, persona cleanup, toy bear cloud persistence, Luze private learning room, Luze autonomy settings and intimacy patches loaded');

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function runtimeBootstrapJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = {
        ...body,
        runtime_bootstrap: 'direct-server-start-v2-cost-guard',
        toybox: 'toy-bear-gomoku-v4',
        toybox_cloud_history: 'drawing-auto-save-v1',
        luze_private_room: body.luze_private_room || 'private-learning-room-v1',
        luze_autonomy: body.luze_autonomy || 'chat-room-access-v1',
        luze_room_knock: 'local-zero-api-v1',
        memory_journal: body.memory_journal || 'local-semantic-summary-v2',
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[runtime:bootstrap] health marker unavailable:', error.message);
}
