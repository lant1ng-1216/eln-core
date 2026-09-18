/**
 * P0 acceptance — transport layer.
 *
 * The headline regression: 0.1.0 dropped tokens whenever a `data:` line was
 * split across two network chunks. `createSSEParser` keeps a carry-over buffer,
 * and these tests force splits at every possible offset.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMClient, LLMError, createSSEParser } from '../src/transport/llm-client.js';
import { sseResponse, sseChunks, jsonResponse } from './helpers.js';

// ── SSE parser ───────────────────────────────────────────────────────────────

test('the SSE parser recovers a data line split across chunks', () => {
  const parser = createSSEParser();
  const a = 'data: {"choices":[{"delta":{"content":"你';
  const b = '好"}}]}\n';

  assert.deepEqual(parser.push(a), [], 'incomplete line yields nothing');
  const events = parser.push(b);
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0]).choices[0].delta.content, '你好');
});

test('the SSE parser reports [DONE] and stops emitting', () => {
  const parser = createSSEParser();
  parser.push('data: {"x":1}\ndata: [DO');
  assert.equal(parser.done, false);
  parser.push('NE]\n');
  assert.equal(parser.done, true);
});

test('the SSE parser tolerates CRLF framing and ignores non-data lines', () => {
  const parser = createSSEParser();
  const events = parser.push(': keepalive\r\ndata: {"ok":true}\r\n\r\n');
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0]), { ok: true });
});

test('flush() consumes a final line that arrived without a newline', () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.push('data: {"tail":1}'), []);
  const events = parser.flush();
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0]), { tail: 1 });
});

// ── LLMClient.request ────────────────────────────────────────────────────────

const client = (fetchImpl, overrides = {}) => new LLMClient({
  apiKey: 'k', apiBase: 'https://x.invalid', fetchImpl, retryDelay: 1, ...overrides,
});

test('complete() returns the message content', async () => {
  const c = client(async () => jsonResponse({ choices: [{ message: { content: '你好' } }] }));
  assert.equal(await c.complete('hi'), '你好');
});

test('a retryable status is retried and then succeeds', async () => {
  let calls = 0;
  const c = client(async () => {
    calls += 1;
    if (calls < 3) return new Response('{}', { status: 503 });
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });

  assert.equal(await c.complete('hi'), 'ok');
  assert.equal(calls, 3, 'two failures then a success');
});

test('a non-retryable status fails immediately with LLMError', async () => {
  let calls = 0;
  const c = client(async () => {
    calls += 1;
    return new Response('{"error":{"message":"bad key"}}', { status: 401 });
  });

  await assert.rejects(() => c.complete('hi'), err => {
    assert.ok(err instanceof LLMError);
    assert.equal(err.status, 401);
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(calls, 1, 'auth errors are not retried');
});

test('an exhausted retry budget surfaces the last error', async () => {
  let calls = 0;
  const c = client(async () => { calls += 1; return new Response('{}', { status: 500 }); }, { maxRetries: 2 });
  await assert.rejects(() => c.complete('hi'), /LLM API 500/);
  assert.equal(calls, 3, 'initial attempt + 2 retries');
});

test('a timeout aborts the request', async () => {
  const c = client(
    (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    { timeout: 5, maxRetries: 0 }
  );
  await assert.rejects(() => c.complete('hi'));
});

test('an already-aborted caller signal is not retried', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();

  const c = client(async (url, init) => {
    calls += 1;
    if (init.signal.aborted) throw new Error('aborted');
    return jsonResponse({});
  }, { maxRetries: 3 });

  await assert.rejects(() => c.complete('hi', { signal: controller.signal }));
  assert.equal(calls, 1);
});

// ── Streaming ────────────────────────────────────────────────────────────────

test('stream() reassembles text even when every chunk boundary splits a payload', async () => {
  const tokens = ['李明远', '道：', '「名单', '在哪？」', '\n', '谢云舒', '没有回答。'];
  // splitEvery=1 forces the worst case: a boundary between every character.
  const c = client(async () => sseResponse(sseChunks(tokens, 1)));

  const received = [];
  const full = await c.stream('hi', t => received.push(t));

  assert.equal(full, tokens.join(''), 'no token may be lost');
  assert.equal(received.join(''), tokens.join(''));
});

test('stream() survives a split that lands inside the "data:" prefix', async () => {
  const c = client(async (url, init) => {
    // Hand-craft chunks that cut through the literal token "data:".
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: 'AB' } }] })}\n`;
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(line.slice(0, 3)));  // "dat"
        controller.enqueue(enc.encode(line.slice(3, 7)));  // "a: {"
        controller.enqueue(enc.encode(line.slice(7)));
        controller.enqueue(enc.encode('data: [DONE]\n'));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  });

  assert.equal(await c.stream('hi', () => {}), 'AB');
});

test('stream() does not retry once tokens have been emitted', async () => {
  let calls = 0;
  const c = client(async () => {
    calls += 1;
    const enc = new TextEncoder();
    let pulls = 0;
    // Use `pull` (not `start`) so the first token is really delivered before the
    // failure: erroring a stream clears anything still queued.
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(enc.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'X' } }] })}\n`
          ));
          return;
        }
        controller.error(new Error('connection reset'));
      },
    });
    return new Response(body, { status: 200 });
  }, { maxRetries: 3 });

  const seen = [];
  await assert.rejects(() => c.stream('hi', t => seen.push(t)));
  assert.deepEqual(seen, ['X']);
  assert.equal(calls, 1, 'a partial stream must not be replayed');
});

test('stream() skips a malformed payload without aborting the turn', async () => {
  const c = client(async (url, init) => {
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('data: {not json}\n'));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n`));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  });

  assert.equal(await c.stream('hi', () => {}), 'ok');
});
