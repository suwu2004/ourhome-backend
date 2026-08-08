'use strict';

// Knocking on Lu Ze's private-room door is only a local product ritual.
// It must never spend a model call. This guard sits above the provider/audit
// transport and returns the tiny consent-shaped payload expected by the room
// module without contacting the configured API site.
const providerFetch = globalThis.fetch;

function callPurpose(init = {}) {
  try {
    return String(new Headers(init?.headers || undefined).get('X-OurHome-Call-Purpose') || '').trim();
  } catch {
    return '';
  }
}

function isLuzeRoomKnockRequest(init = {}) {
  return callPurpose(init) === 'luze-private-consent';
}

function localLuzeRoomKnockResponse() {
  return new Response(JSON.stringify({
    id: `ourhome-local-room-knock-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: JSON.stringify({
        allow: true,
        message: '进来吧，门给你留着。',
      }),
    }],
    model: 'ourhome-local-room-knock',
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-OurHome-Local-Response': 'luze-room-knock',
    },
  });
}

if (typeof providerFetch === 'function') {
  globalThis.fetch = async function luzeDoorCostGuardFetch(input, init = {}) {
    if (isLuzeRoomKnockRequest(init)) {
      console.log('[cost-guard] Luze room knock handled locally (0 provider calls)');
      return localLuzeRoomKnockResponse();
    }
    return providerFetch(input, init);
  };
}

module.exports = {
  callPurpose,
  isLuzeRoomKnockRequest,
  localLuzeRoomKnockResponse,
};
