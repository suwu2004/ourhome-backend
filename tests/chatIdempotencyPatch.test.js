'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  chatRequestFingerprint,
  normalizeRequestId,
} = require('../chatIdempotencyPatch');

test('Chat request ids accept only compact safe tokens', () => {
  assert.equal(normalizeRequestId('chat-12345678'), 'chat-12345678');
  assert.equal(normalizeRequestId('tiny'), '');
  assert.equal(normalizeRequestId('bad request id'), '');
});

test('Chat request fingerprint changes when the logical request changes', () => {
  const base = {
    headers: { authorization: 'Bearer one' },
    body: { session_id: 22, message: 'hello', model: 'model-a' },
  };
  assert.equal(chatRequestFingerprint(base), chatRequestFingerprint({ ...base, body: { ...base.body } }));
  assert.notEqual(chatRequestFingerprint(base), chatRequestFingerprint({ ...base, body: { ...base.body, message: 'hello again' } }));
});

test('duplicate in-flight /chat requests with the same request id execute the handler once', async (t) => {
  const app = express();
  app.use(express.json());
  let calls = 0;
  app.post('/chat', async (req, res) => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 80));
    res.json({ ok: true, calls, message: req.body.message });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test',
      'X-OurHome-Request-Id': 'chat-network-12345678',
    },
    body: JSON.stringify({ session_id: 22, message: 'only once', model: 'model-a' }),
  };

  const [left, right] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/chat`, options),
    fetch(`http://127.0.0.1:${port}/chat`, options),
  ]);
  const [leftBody, rightBody] = await Promise.all([left.json(), right.json()]);

  assert.equal(calls, 1);
  assert.deepEqual(leftBody, rightBody);
  assert.ok(left.headers.get('X-OurHome-Idempotent-Replay') === '1' || right.headers.get('X-OurHome-Idempotent-Replay') === '1');
});

test('duplicate in-flight theater Chat requests execute the paid handler once', async (t) => {
  const app = express();
  app.use(express.json());
  let calls = 0;
  app.post('/theater/books/:id/chat', async (req, res) => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 80));
    res.json({ ok: true, calls, book: req.params.id, message: req.body.message });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer theater-test',
      'X-OurHome-Request-Id': 'theater-network-12345678',
    },
    body: JSON.stringify({ message: 'only once', model: 'model-a', play_mode: 'interactive' }),
  };

  const [left, right] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/theater/books/book-1/chat`, options),
    fetch(`http://127.0.0.1:${port}/theater/books/book-1/chat`, options),
  ]);
  const [leftBody, rightBody] = await Promise.all([left.json(), right.json()]);

  assert.equal(calls, 1);
  assert.deepEqual(leftBody, rightBody);
  assert.ok(left.headers.get('X-OurHome-Idempotent-Replay') === '1' || right.headers.get('X-OurHome-Idempotent-Replay') === '1');
});

test('duplicate theater regenerate retries reuse one paid generation', async (t) => {
  const app = express();
  app.use(express.json());
  let calls = 0;
  app.post('/theater/books/:id/messages/:messageId/regenerate', async (req, res) => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 80));
    res.json({ ok: true, calls, messageId: req.params.messageId });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer theater-regen-test',
      'X-OurHome-Request-Id': 'theater-regen-12345678',
    },
    body: JSON.stringify({ model: 'model-a', play_mode: 'interactive' }),
  };

  const [left, right] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/theater/books/book-1/messages/message-2/regenerate`, options),
    fetch(`http://127.0.0.1:${port}/theater/books/book-1/messages/message-2/regenerate`, options),
  ]);
  const [leftBody, rightBody] = await Promise.all([left.json(), right.json()]);

  assert.equal(calls, 1);
  assert.deepEqual(leftBody, rightBody);
  assert.ok(left.headers.get('X-OurHome-Idempotent-Replay') === '1' || right.headers.get('X-OurHome-Idempotent-Replay') === '1');
});

test('reusing a Chat request id for different content is rejected instead of generating again', async (t) => {
  const app = express();
  app.use(express.json());
  let calls = 0;
  app.post('/chat', async (req, res) => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 60));
    res.json({ ok: true });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test-two',
    'X-OurHome-Request-Id': 'chat-network-abcdefgh',
  };

  const first = fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST', headers, body: JSON.stringify({ session_id: 22, message: 'first' }),
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST', headers, body: JSON.stringify({ session_id: 22, message: 'different' }),
  });
  await first;

  assert.equal(second.status, 409);
  assert.equal(calls, 1);
});
