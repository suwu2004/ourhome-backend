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
require('./contextLedgerPatch');
require('./chatCurrentTurnGuardPatch');
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
// lore/memory layers have been assembled. This never trims user/assistant turns.
require('./theaterPromptBudgetPatch');
// Final provider-boundary guard: keep Theater generation inside the intended
// recent-dialogue window after all other fetch wrappers have had their chance.
require('./theaterContextWindowPatch');
// Last provider-boundary guard: prevent the server's generous fallback
// max_tokens from overriding the Theater reply-length setting.
require('./theaterReplyLengthGuardPatch');

module.exports = { renderFrontdoorPatch };