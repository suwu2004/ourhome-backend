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
// Theater memory is a sparse checkpoint, not a second reply engine.
// The economy patch only decides when a checkpoint is worthwhile.
require('./theaterMemoryEconomyPatch');
require('./theaterMemoryPatch');
// The single authoritative Theater continuity layer: real user/assistant turns
// plus one compact timeline instruction at the final provider boundary.
require('./theaterRawTurnsPatch');
// Keep the generation context aligned with the intended recent-dialogue window.
// This runs after Raw Turns so every downstream provider sees at most the
// configured recent Theater messages, while long-term memory stays separate.
require('./theaterContextWindowPatch');
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

module.exports = { renderFrontdoorPatch };
