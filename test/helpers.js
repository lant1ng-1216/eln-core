/**
 * Shared test fixtures. Not a test file — `package.json` runs `test/*.test.js`
 * explicitly so this module is never collected by the runner.
 */

import { canonFromGeneratedWorld } from '../src/state/canon.js';
import { createMinds } from '../src/state/mind.js';
import { createLedgers } from '../src/state/ledger.js';

/** A three-character world used across tests. */
export const FIXTURE_WORLD = {
  name: '雾港',
  tag: '民国·谍战',
  background: '一九四三年的上海，各方势力在租界暗处角力。',
  outline: '一份失踪的名单牵动所有人的命运。',
  characters: [
    { name: '李明远', role: '报社主编', personality: '沉稳多疑', secret: '实为地下党联络员', goal: '找到失踪名单', weightTag: '男主' },
    { name: '谢云舒', role: '舞厅老板', personality: '八面玲珑', secret: '替军统传递情报', goal: '保全自身', weightTag: '女主' },
    { name: '赵鹏', role: '巡捕房探长', personality: '贪财怕事', secret: '早已被日谍收买', goal: '捞够钱离开上海', weightTag: '反派' },
  ],
  chapters: [
    { name: '第一章 失踪', goal: '引出名单之谜' },
    { name: '第二章 交锋', goal: '迫使两人正面冲突' },
  ],
};

/** Build `{canon, minds, ledgers, turnRecords}` from a generated-world payload. */
export function makeState(world = FIXTURE_WORLD) {
  const canon = canonFromGeneratedWorld(world, 1_700_000_000_000);
  return {
    canon,
    minds: createMinds(canon),
    ledgers: createLedgers(),
    turnRecords: [],
  };
}

/** A narrative that satisfies nothing in particular — tests assert on state. */
export const SAMPLE_NARRATIVE =
  '李明远道：「名单的事，你究竟知道多少？」\n' +
  '（内心：她今天的神色不对。）\n' +
  '谢云舒笑了笑，没有回答，只把烟按灭在碟沿上。';

/** Minimal extraction payload matching SAMPLE_NARRATIVE. */
export function sampleExtraction(overrides = {}) {
  return {
    summary: '李明远试探谢云舒，未果。',
    world: { location: '霞飞路舞厅', time: '深夜', tension: 45 },
    characters: [
      { name: '李明远', emotion: '警觉', goal: '试探谢云舒' },
      { name: '谢云舒', emotion: '戒备', trust_changes: { 李明远: -5 } },
    ],
    facts: [
      { subject: '李明远', predicate: 'seeks', predicate_raw: '寻找', object: '失踪名单', tags: [], salience: 0.9 },
    ],
    events: [
      { kind: 'dialogue', actors: ['李明远', '谢云舒'], summary: '李明远试探谢云舒' },
    ],
    seeds: [
      { text: '名单到底藏在哪', kind: 'question', holderIds: ['李明远'] },
    ],
    knowledge: [
      { holderId: '李明远', factIndex: 0, stance: 'knows' },
    ],
    editor: { chapter_progress: 0.3, suggest_close_chapter: false, note: '节奏偏慢' },
    ...overrides,
  };
}

// ── Fake clients ─────────────────────────────────────────────────────────────

/** A narrative client that emits `text` through `onToken` in one delta. */
export function fakeNarrativeClient(text = SAMPLE_NARRATIVE, { failAt = null } = {}) {
  return {
    calls: 0,
    async stream(prompt, onToken) {
      this.calls += 1;
      if (failAt === 'stream') throw new Error('simulated stream failure');
      onToken?.(text);
      return text;
    },
  };
}

/** An extraction client returning `payload` (object or raw string). */
export function fakeExtractionClient(payload = sampleExtraction(), { failAt = null } = {}) {
  return {
    calls: 0,
    prompts: [],
    async complete(prompt) {
      this.calls += 1;
      this.prompts.push(prompt);
      if (failAt === 'complete') throw new Error('simulated extraction failure');
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    },
  };
}

// ── HTTP-level fakes (for LLMClient / ELNRuntime tests) ──────────────────────

/** Build a `Response` whose body streams `chunks` — used to test SSE framing. */
export function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Split SSE `data:` payloads into chunks that deliberately straddle boundaries. */
export function sseChunks(tokens, splitEvery = 3) {
  const encoderLines = tokens.map(
    t => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`
  );
  encoderLines.push('data: [DONE]\n');
  const full = encoderLines.join('');
  const chunks = [];
  for (let i = 0; i < full.length; i += splitEvery) chunks.push(full.slice(i, i + splitEvery));
  return chunks;
}

/** The text a `sseChunks(tokens)` stream should reconstruct to. */
export const reconstruct = tokens => tokens.join('');

/**
 * A `fetch` implementation routing on the request body:
 * streaming requests get SSE, others get JSON.
 */
export function mockFetch({ tokens = ['你好', '，', '世界'], json = {}, status = 200, onRequest } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    onRequest?.(url, body, init);
    if (status !== 200) return new Response('{"error":{"message":"boom"}}', { status });
    if (body.stream) return sseResponse(sseChunks(tokens));
    return jsonResponse(json);
  };
}

/** Full runtime options wired to fakes, for end-to-end turn tests. */
export function runtimeOptions(overrides = {}) {
  const extraction = overrides.extraction ?? sampleExtraction();
  const handler = async (url, init) => {
    const body = JSON.parse(init.body);
    overrides.onRequest?.(url, body, init);
    if (body.stream) return sseResponse(sseChunks([SAMPLE_NARRATIVE]));
    return jsonResponse(extraction);
  };
  return {
    apiKey: 'test-key',
    apiBase: 'https://example.invalid',
    fetchImpl: handler,
    ...overrides,
  };
}
