'use strict';

function createKeyedSerialQueue() {
  const pending = new Map();

  function run(key, task) {
    const normalizedKey = String(key ?? '').trim();
    if (!normalizedKey) return Promise.reject(new TypeError('A non-empty queue key is required'));
    if (typeof task !== 'function') return Promise.reject(new TypeError('Queue task must be a function'));

    const previous = pending.get(normalizedKey) || Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tracked = current.finally(() => {
      if (pending.get(normalizedKey) === tracked) pending.delete(normalizedKey);
    });
    pending.set(normalizedKey, tracked);
    return tracked;
  }

  return {
    run,
    get pendingCount() {
      return pending.size;
    },
  };
}

module.exports = { createKeyedSerialQueue };
