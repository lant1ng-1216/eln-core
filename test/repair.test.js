/**
 * Regression tests for extraction repair, driven by a real failure.
 *
 * Running `scripts/verify.js` against DeepSeek exposed this: the extraction
 * response hit `max_tokens` (finish_reason = 'length'), the JSON came back
 * truncated, and the turn committed with **nothing extracted** — no events, no
 * seeds, tension frozen. The prose looked fine, so the failure was invisible.
 *
 * The mock transport in the rest of the suite cannot catch that class of bug,
 * because it always returns well-formed JSON. These tests model the truncation
 * signal explicitly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractWithRepair, buildRepairPrompt } from '../src/orchestration/repair.js';
import { LLMClient } from '../src/transport/llm-client.js';
import { jsonResponse, sampleExtraction } from './helpers.js';

/** A client whose responses are scripted per call, with an optional finishReason. */
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    async completeWithMeta(prompt, options = {}) {
      calls.push({ prompt, ...options });
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      return typeof step === 'function' ? step(prompt, options) : step;
    },
  };
}

const ok = payload => ({ content: JSON.stringify(payload), finishReason: 'stop' });

/** A response cut off mid-JSON — exactly what truncation produces. */
const truncated = payload => ({
  content: `${JSON.stringify(payload).slice(0, 40)}`,
  finishReason: 'length',
});

// ── The truncation signal reaches the repair logic ───────────────────────────

test('a truncated first attempt is diagnosed as truncation, not bad data', async () => {
  const client = fakeClient([
    truncated(sampleExtraction()),
    ok(sampleExtraction()),
  ]);

  const result = await extractWithRepair({ client, prompt: 'P', maxTokens: 900 });

  assert.match(client.calls[0].prompt, /^P$/, 'first attempt uses the original prompt');
  assert.equal(result.attempts, 2);
  assert.equal(result.degraded.includes('root'), false, 'the retry recovered');
});

test('the retry prompt carries compactness guidance and a bigger budget', async () => {
  const client = fakeClient([
    truncated(sampleExtraction()),
    ok(sampleExtraction()),
  ]);

  await extractWithRepair({ client, prompt: 'P', maxTokens: 900 });

  assert.equal(client.calls[1].maxTokens, 1350, 'budget is raised by 1.5x');
  assert.match(client.calls[1].prompt, /被\*\*截断\*\*/, 'the cause is named');
  assert.match(client.calls[1].prompt, /facts 最多 6 条/, 'concrete caps are given');
});

test('a non-truncated malformed response does not get compactness advice', async () => {
  const client = fakeClient([
    { content: '这不是 JSON', finishReason: 'stop' },
    ok(sampleExtraction()),
  ]);

  await extractWithRepair({ client, prompt: 'P', maxTokens: 900 });

  assert.equal(client.calls[1].maxTokens, 900, 'budget unchanged — size was not the problem');
  assert.ok(!client.calls[1].prompt.includes('被**截断**'));
  assert.match(client.calls[1].prompt, /unparseable response/);
});

test('a truncated attempt loses the merge to a complete retry', async () => {
  // Truncation can chop off trailing content while leaving a valid object. The
  // first payload parses, so a naive merge would keep it and silently drop
  // everything after the cut.
  const client = fakeClient([
    { content: JSON.stringify({ summary: '只有摘要' }), finishReason: 'length' },
    ok(sampleExtraction({ summary: '补全后' })),
  ]);

  const result = await extractWithRepair({ client, prompt: 'P', maxTokens: 900 });

  assert.equal(result.attempts, 2, 'truncation alone triggers a repair');
  assert.equal(result.blocks.summary, '补全后', 'the complete retry wins');
  assert.equal(result.blocks.facts.length, 1, 'the retry restored the lost blocks');
});

test('when both attempts truncate, the loss is reported rather than hidden', async () => {
  const client = fakeClient([
    truncated(sampleExtraction()),
    truncated(sampleExtraction()),
  ]);

  const result = await extractWithRepair({ client, prompt: 'P', maxTokens: 900 });

  assert.equal(result.attempts, 2);
  assert.deepEqual(result.degraded, ['root']);
  assert.match(result.errors.root, /被 max_tokens=1350 截断/);
});

test('the truncation marker survives a merge that produced usable blocks', async () => {
  const client = fakeClient([
    { content: JSON.stringify(sampleExtraction({ summary: 'A' })), finishReason: 'length' },
    { content: JSON.stringify(sampleExtraction({ summary: 'B' })), finishReason: 'length' },
  ]);

  const result = await extractWithRepair({ client, prompt: 'P', maxTokens: 900 });

  assert.ok(
    result.degraded.includes('truncated'),
    'content may be missing even though the payload parses'
  );
  assert.match(result.errors.truncated, /max_tokens/);
});

test('a client without completeWithMeta still works', async () => {
  const calls = [];
  const legacy = {
    async complete(prompt, options) {
      calls.push({ prompt, ...options });
      return JSON.stringify(sampleExtraction());
    },
  };

  const result = await extractWithRepair({ client: legacy, prompt: 'P', maxTokens: 900 });

  assert.equal(result.attempts, 1);
  assert.deepEqual(result.degraded, []);
  assert.equal(calls.length, 1);
});

test('buildRepairPrompt omits compactness by default and includes it on request', () => {
  const plain = buildRepairPrompt('BASE', ['world'], { world: 'bad' });
  const compact = buildRepairPrompt('BASE', ['world'], { world: 'bad' }, { truncated: true });

  assert.ok(!plain.includes('被**截断**'));
  assert.match(compact, /facts 最多 6 条/);
  assert.match(compact, /BASE/);
});

// ── The transport actually reports the signal ────────────────────────────────

test('completeWithMeta surfaces finish_reason and still meters usage', async () => {
  const client = new LLMClient({
    apiKey: 'k',
    apiBase: 'https://x.invalid',
    fetchImpl: async () => jsonResponse({
      choices: [{ message: { content: '{"a":1}' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }),
  });

  const meta = await client.completeWithMeta('hi', { maxTokens: 5 });

  assert.equal(meta.content, '{"a":1}');
  assert.equal(meta.finishReason, 'length');
  assert.equal(client.usage.snapshot().totalTokens, 10);
  assert.equal(client.usage.snapshot().calls, 1);
});

test('complete() delegates without double-counting usage', async () => {
  const client = new LLMClient({
    apiKey: 'k',
    apiBase: 'https://x.invalid',
    fetchImpl: async () => jsonResponse({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }),
  });

  assert.equal(await client.complete('hi'), 'ok');
  assert.equal(client.usage.snapshot().calls, 1, 'exactly one call recorded');
  assert.equal(client.usage.snapshot().totalTokens, 5);
});

test('a missing finish_reason is null, not an error', async () => {
  const client = new LLMClient({
    apiKey: 'k',
    apiBase: 'https://x.invalid',
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
  });

  const meta = await client.completeWithMeta('hi');
  assert.equal(meta.finishReason, null);
  assert.equal(meta.reported, false, 'no usage reported by the provider');
});
