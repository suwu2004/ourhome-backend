'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeyedSerialQueue } = require('../sessionSummaryQueue');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('operations sharing a key run one at a time and preserve submission order', async () => {
  const queue = createKeyedSerialQueue();
  const firstGate = deferred();
  const order = [];
  let active = 0;
  let maxActive = 0;

  const first = queue.run('session-1', async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push('first:start');
    await firstGate.promise;
    order.push('first:end');
    active -= 1;
    return 'first';
  });
  const second = queue.run('session-1', async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push('second:start');
    active -= 1;
    return 'second';
  });

  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  assert.equal(queue.pendingCount, 1);
  firstGate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
  assert.equal(queue.pendingCount, 0);
});

test('different keys can execute concurrently', async () => {
  const queue = createKeyedSerialQueue();
  const gate = deferred();
  let active = 0;
  let maxActive = 0;
  const task = key => queue.run(key, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate.promise;
    active -= 1;
  });

  const first = task('session-1');
  const second = task('session-2');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(maxActive, 2);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(queue.pendingCount, 0);
});

test('a rejected task does not block the next task for the same key', async () => {
  const queue = createKeyedSerialQueue();
  const first = queue.run('session-1', async () => {
    throw new Error('expected failure');
  });
  const second = queue.run('session-1', async () => 'recovered');

  await assert.rejects(first, /expected failure/);
  assert.equal(await second, 'recovered');
  assert.equal(queue.pendingCount, 0);
});

test('invalid task inputs are rejected without creating queue entries', async () => {
  const queue = createKeyedSerialQueue();
  await assert.rejects(queue.run('', () => undefined), /non-empty queue key/);
  await assert.rejects(queue.run('session-1', null), /task must be a function/);
  assert.equal(queue.pendingCount, 0);
});
