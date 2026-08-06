const MEMORY_TIERS = Object.freeze(['temporary', 'episodic', 'core', 'archived']);
const ACTIVE_MEMORY_TIERS = Object.freeze(['temporary', 'episodic', 'core']);

function requestMethod(input, init = {}) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return String(input?.url || '');
}

function isMemoryTableRead(input, init = {}) {
  if (requestMethod(input, init) !== 'GET') return false;
  const url = requestUrl(input);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return /\/rest\/v1\/memories$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function addActiveMemoryFilters(url, now = new Date()) {
  const parsed = new URL(String(url));
  if (!parsed.searchParams.has('memory_tier')) {
    parsed.searchParams.set('memory_tier', 'neq.archived');
  }
  if (!parsed.searchParams.has('or')) {
    parsed.searchParams.set('or', `(expires_at.is.null,expires_at.gt.${now.toISOString()})`);
  }
  return parsed.toString();
}

function filteredMemoryInput(input, init = {}, now = new Date()) {
  if (!isMemoryTableRead(input, init)) return input;
  const filteredUrl = addActiveMemoryFilters(requestUrl(input), now);
  if (typeof input === 'string') return filteredUrl;
  if (input instanceof URL) return new URL(filteredUrl);
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return new Request(filteredUrl, input);
  }
  return input;
}

function layerLabel(tier) {
  switch (tier) {
    case 'core': return '核心记忆';
    case 'temporary': return '临时记忆';
    case 'archived': return '已归档';
    default: return '阶段记忆';
  }
}

module.exports = {
  MEMORY_TIERS,
  ACTIVE_MEMORY_TIERS,
  requestMethod,
  requestUrl,
  isMemoryTableRead,
  addActiveMemoryFilters,
  filteredMemoryInput,
  layerLabel,
};
