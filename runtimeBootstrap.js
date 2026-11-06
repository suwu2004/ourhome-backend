'use strict';

// Keep every runtime compatibility layer aligned across direct `node server.js`
// startup and `npm start`. Requiring a patch again from npm preload is harmless
// because Node caches modules. Protect the outer Chat send first, then suppress
// repeated real Supabase REST 402s before the Neon fallback captures fetch.
require('./chatIdempotencyPatch');
require('./supabaseQuotaCircuitPatch');
require('./neonFailoverFetchPatch');
require('./theaterMemoryFactDedupPatch');
require('./memoryLayerPatch');
require('./modelTokenLimitPatch');
require('./thinkingTransportPatch');
require('./apiUsageAuditPatch');
require('./nonChatBudgetPatch');
require('./backgroundAiCostGuardPatch');
require('./modelCallSingleflightPatch');
require('./theaterMemoryEconomyPatch');
require('./theaterMemoryPatch');
require('./theaterRawTurnsPatch');
require('./theaterPromptAutonomyPatch');
const { guardRenderFrontend } = require('./renderFrontendIntegrityGuard');
guardRenderFrontend();
const renderFrontdoorPatch = require('./renderFrontdoorPatch');
require('./memoryJournalPresentationPatch');
require('./luzeDoorCostGuardPatch');
require('./luzeLearningResiliencePatch');
require('./runtimeTimeoutGuardPatch');
require('./photoRetentionPatch');
require('./photoMemoryVisionPatch');
// The fetch wrappers are nested: the context ledger must be injected first,
// then the current-turn guard must be appended after it, immediately before the
// final provider payload budget. This keeps historical context from outranking
// the live dialogue simply because it was appended later.
require('./mainChatPayloadBudgetPatch');
require('./chatCurrentTurnGuardPatch');
require('./contextLedgerPatch');
require('./lorebookPatch');
require('./intimacyFlowAutonomyPatch');
require('./chatPromptCleanupPatch');
require('./chatToolEconomyPatch');
require('./chatHistorySearchResiliencePatch');
require('./theaterMessagePagingPatch');
require('./theaterBranchActionsPatch');
require('./toyboxRoutePatch');
require('./toyboxSocialRoutePatch');
require('./toyboxDrawingPersistencePatch');
require('./drawingRoutePatch');
require('./luzePrivateRoomPatch');
require('./luzeAutonomySettingsPatch');
require('./intimacyFlowPatch');
// Reserve provider context for actual recent Theater dialogue after all static
// lore/memory layers have been assembled. This mirrors formal Chat's 15k-token
// context economy and preserves literal live turns as the highest-priority layer.
require('./theaterPromptBudgetPatch');
// Final provider-boundary guard: keep Theater generation inside the same
// 50-round / 100-message ceiling used by formal Chat.
require('./theaterContextWindowPatch');
// Provider token guard: make the configured Theater reply length a one-call
// target and reserve enough output budget for the provider to complete it.
require('./theaterReplyLengthGuardPatch');
// Finally, carry formal Chat's provider-native thinking transport into Theater.
// This never creates a second completion just to manufacture a thinking panel.
require('./theaterThinkingPatch');
// Session-summary economy: a long window must not fan out into dozens of provider calls.
require('./sessionSummaryEconomyPatch');
// Main Chat has one final payload-budget owner. It runs after historical ledger
// injection and current-turn prioritization, so there is no earlier competing trim.

module.exports = { renderFrontdoorPatch };
