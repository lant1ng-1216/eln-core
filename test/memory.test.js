/**
 * P1 acceptance — memory and provenance.
 *
 * The claim under test (DESIGN §9 P1): a turn late in the story can correctly
 * cite a detail planted near the beginning. That is only possible because the
 * prose is retained and retrieved, so these tests exercise the store, the
 * scorer, and the wiring into prompt assembly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ELNRuntime } from '../src/runtime.js';
import { ProseStore } from '../src/memory/prose.js';
import { tokenize, tokenSet, scoreRecord } from '../src/memory/keywords.js';
import { KeywordRetriever, buildQuery } from '../src/memory/retriever.js';
import { MemoryStorage } from '../src/memory/adapters/memory-storage.js';
import { addSeed } from '../src/state/ledger.js';
import { genrePack } from '../src/expression/packs/genres/index.js';
import { stylePack } from '../src/expression/packs/styles/index.js';
import {
  FIXTURE_WORLD, sampleExtraction, sseResponse, sseChunks, jsonResponse,
} from './helpers.js';

const completionResponse = payload => jsonResponse({
  choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }],
});

function makeRuntime({ fetchOpts = {}, runtimeOpts = {}, storage = new MemoryStorage() } = {}) {
  let streamCalls = 0;

  const handler = async (url, init) => {
    const body = JSON.parse(init.body);
    fetchOpts.onBody?.(body);
    if (body.stream) {
      // `narratives` cycles so a multi-turn test gets distinct prose per turn.
      const script = fetchOpts.narratives;
      const text = script
        ? script[Math.min(streamCalls, script.length - 1)]
        : fetchOpts.narrative ?? '平淡的一回合。';
      streamCalls += 1;
      return sseResponse(sseChunks([text]));
    }
    const prompt = body.messages[0].content;
    if (prompt.includes('世界名称')) return completionResponse(FIXTURE_WORLD);
    return completionResponse(fetchOpts.extraction ?? sampleExtraction());
  };

  const runtime = new ELNRuntime({
    apiKey: 'test-key',
    apiBase: 'https://example.invalid',
    packs: [genrePack('republican'), stylePack('zh-literary')],
    storage,
    fetchImpl: handler,
    ...runtimeOpts,
  });
  return { runtime, storage };
}

const loadWorld = async runtime => {
  runtime.loadWorld(await runtime.generateWorld({ genre: 'republican' }));
};

// ── Prose store ──────────────────────────────────────────────────────────────

test('ProseStore appends, reads back and keeps turns ordered', () => {
  const store = new ProseStore();
  store.append(2, '第二回合');
  store.append(1, '第一回合');

  assert.equal(store.size, 2);
  assert.deepEqual(store.all().map(r => r.turn), [1, 2]);
  assert.equal(store.get(1).text, '第一回合');
  assert.equal(store.get(99), undefined);
  assert.equal(store.last(1)[0].turn, 2);
});

test('re-appending a turn replaces it instead of duplicating', () => {
  const store = new ProseStore();
  store.append(1, '初稿');
  store.append(1, '定稿');

  assert.equal(store.size, 1);
  assert.equal(store.get(1).text, '定稿');
});

test('ProseStore evicts the oldest records past its ring size', () => {
  const store = new ProseStore({ maxRecords: 3 });
  for (let t = 1; t <= 5; t++) store.append(t, `第${t}回合`);

  assert.deepEqual(store.all().map(r => r.turn), [3, 4, 5]);
});

test('ProseStore round-trips through JSON', () => {
  const store = new ProseStore({ maxRecords: 10 });
  store.append(1, '第一回合', { entityIds: ['e1'], chapter: 0 });

  const restored = ProseStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
  assert.equal(restored.size, 1);
  assert.deepEqual(restored.get(1).entityIds, ['e1']);
});

// ── Tokenizer & scoring ──────────────────────────────────────────────────────

test('CJK runs become bigrams and latin becomes lowercase words', () => {
  const tokens = tokenize('失踪名单 list');
  assert.ok(tokens.includes('失踪'));
  assert.ok(tokens.includes('踪名'));
  assert.ok(tokens.includes('名单'));
  assert.ok(tokens.includes('list'));
  assert.ok(!tokens.includes('失踪名单'), 'a 4-char run is not kept whole');
});

test('tokenize handles punctuation, mixed scripts and empty input', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('。。。'), []);
  assert.ok(tokenSet('a，b').has('a'));
  assert.ok(tokenSet('a，b').has('b'));
});

test('entity overlap is weighted above bare lexical overlap', () => {
  const query = tokenSet('名单');
  const withEntity = scoreRecord(
    { turn: 1, text: '无关内容', entityIds: ['e1'] },
    query,
    { entityIds: ['e1'] }
  );
  const lexicalOnly = scoreRecord(
    { turn: 1, text: '名单', entityIds: [] },
    query,
    { entityIds: ['e1'] }
  );

  assert.ok(withEntity > lexicalOnly, 'sharing the cast matters more than one shared word');
});

test('a record with no overlap scores zero', () => {
  assert.equal(scoreRecord({ turn: 1, text: '完全无关', entityIds: [] }, tokenSet('名单')), 0);
  assert.equal(scoreRecord({ turn: 1, text: '名单' }, new Set()), 0);
});

// ── Retriever ────────────────────────────────────────────────────────────────

test('the retriever ranks the relevant turn first and honours excludeTurns', () => {
  const store = new ProseStore();
  store.append(3, '李明远把名单藏进了教堂的钟里。', { entityIds: ['e1'] });
  store.append(4, '两人在雨里走了很久，谁也没说话。');
  store.append(5, '名单的事再无下文。', { entityIds: ['e1'] });

  const retriever = new KeywordRetriever({ store, limit: 5, minScore: 0 });
  const hits = retriever.search('名单 李明远', { entityIds: ['e1'] });

  assert.equal(hits[0].record.turn, 3, 'the passage that names both the actor and the object wins');

  const filtered = retriever.search('名单 李明远', { entityIds: ['e1'], excludeTurns: [3] });
  assert.ok(!filtered.some(h => h.record.turn === 3), 'excluded turns are dropped');
});

test('the retriever respects minScore so weak matches are not injected', () => {
  const store = new ProseStore();
  store.append(1, '完全无关的一段叙述。');
  const retriever = new KeywordRetriever({ store });

  assert.deepEqual(retriever.search('名单'), []);
});

test('retrieve() truncates long passages and reports the score', () => {
  const store = new ProseStore();
  store.append(1, `名单${'很长'.repeat(200)}`);
  const retriever = new KeywordRetriever({ store, minScore: 0 });

  const [hit] = retriever.retrieve('名单', { maxChars: 50 });
  assert.ok(hit.text.length <= 51);
  assert.equal(typeof hit.score, 'number');
});

test('a retriever with no store returns nothing rather than throwing', () => {
  const retriever = new KeywordRetriever();
  assert.deepEqual(retriever.search('名单'), []);
  assert.deepEqual(retriever.retrieve('名单'), []);
});

test('buildQuery combines actor names with the threads coming due', () => {
  const canon = { entities: [{ id: 'e1', name: '李明远' }, { id: 'e2', name: '谢云舒' }] };
  const query = buildQuery({
    canon,
    openSeeds: [{ text: '名单到底在哪' }],
    entityIds: ['e1'],
  });

  assert.match(query, /李明远/);
  assert.match(query, /名单到底在哪/);
  assert.ok(!query.includes('谢云舒'), 'only the actors handed in are used');
});

// ── Wiring into a turn ───────────────────────────────────────────────────────

test('an earlier turn’s prose is injected into the narrative prompt', async () => {
  let prompt = '';
  const { runtime } = makeRuntime({
    fetchOpts: { onBody: body => { if (body.stream) prompt = body.messages[0].content; } },
  });
  await loadWorld(runtime);

  const li = runtime.getCharacter('李明远').id;
  // Prose from turn 3 — long before the turn about to be written.
  runtime.prose.append(3, '李明远把失踪名单藏进了教堂钟楼的夹层。', { entityIds: [li] });

  // The director must advance 李明远, and the retrieval query is built from
  // exactly that — so the engine goes back and re-reads turn 3.
  await runtime.runTurn();

  assert.match(prompt, /相关旧事/, 'a retrieval block was assembled');
  assert.match(prompt, /教堂钟楼/, 'the turn-3 detail resurfaced');
});

test('a detail planted in turn 2 is still cited at turn 6', async () => {
  let prompt = '';
  const { runtime } = makeRuntime({
    fetchOpts: {
      narratives: [
        '第一回合，两人在码头接头。',
        '第二回合，李明远把失踪名单藏进教堂钟楼的夹层。',
        '第三回合，雨夜追捕，脚步声响彻长街。',
        '第四回合，谢云舒收到一封匿名警告。',
        '第五回合，赵鹏开始怀疑身边的人。',
        '第六回合，风声渐紧。',
      ],
      onBody: body => { if (body.stream) prompt = body.messages[0].content; },
    },
  });
  await loadWorld(runtime);

  // A thread the director will keep in the retrieval query.
  runtime.plantSeed('失踪名单的下落');

  for (let i = 0; i < 6; i++) await runtime.runTurn();

  assert.equal(runtime.prose.size, 6);

  const li = runtime.getCharacter('李明远').id;
  const hits = runtime.searchProse('失踪名单 李明远', { entityIds: [li] });
  assert.equal(hits[0]?.turn, 2, 'turn 2 is the top hit for its own detail');

  assert.match(prompt, /相关旧事/, 'turn 6 assembled a retrieval block');
  assert.match(prompt, /教堂钟楼/, 'the turn-2 detail reached the turn-6 prompt');
  assert.ok(!prompt.includes('第五回合'), 'recent turns are excluded from retrieval');
});

test('prose is retained per turn and stays readable afterwards', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  await runtime.runTurn();
  await runtime.runTurn();

  assert.equal(runtime.prose.size, 2);
  assert.equal(runtime.prose.get(1).text, '平淡的一回合。');
  assert.deepEqual(runtime.prose.all().map(r => r.turn), [1, 2]);
});

test('a just-written turn is not duplicated into the retrieval block', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  await runtime.runTurn();

  const retrieved = runtime.searchProse('平淡', { excludeTurns: [1] });
  assert.deepEqual(retrieved, [], 'recent turns are excluded from retrieval');
});

// ── Provenance ───────────────────────────────────────────────────────────────

test('an extracted fact keeps a traceable quote back to the prose', async () => {
  const extraction = sampleExtraction({
    facts: [{
      subject: '李明远',
      predicate: 'seeks',
      object: '失踪名单',
      evidence: '名单的事，你究竟知道多少？',
      salience: 0.9,
    }],
  });
  const { runtime } = makeRuntime({ fetchOpts: { extraction } });
  await loadWorld(runtime);
  await runtime.runTurn();

  const fact = runtime.getState().canon.facts.find(f => f.object === '失踪名单');
  assert.deepEqual(fact.evidence, { turn: 1, quote: '名单的事，你究竟知道多少？' });
});

test('a fact with no quoted evidence still records which turn produced it', async () => {
  const extraction = sampleExtraction({
    facts: [{ subject: '赵鹏', predicate: 'owes', object: '某人人情' }],
  });
  const { runtime } = makeRuntime({ fetchOpts: { extraction } });
  await loadWorld(runtime);
  await runtime.runTurn();

  const fact = runtime.getState().canon.facts.find(f => f.object === '某人人情');
  assert.deepEqual(fact.evidence, { turn: 1, quote: '' });
});

// ── Mention-aware urgency ────────────────────────────────────────────────────

test('a thread that keeps resurfacing outranks one that was forgotten', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  // Keep the chapter open so the chapter-end term does not dominate, and let
  // both seeds age equally: only the mention count may separate them.
  const canon = runtime.getState().canon;
  canon.chapters[0].targetTurns = 50;
  canon.turn = 1;

  for (const text of ['名单还压在钟楼下。', '他又想起了名单。', '名单仍未找到。']) {
    runtime.prose.append(runtime.prose.size + 1, text);
  }

  runtime.plantSeed('失踪名单');
  runtime.plantSeed('一枚旧怀表');

  await runtime.runTurn();

  const seeds = runtime.listSeeds({ status: 'open' });
  const mentioned = seeds.find(s => s.text === '失踪名单');
  const forgotten = seeds.find(s => s.text === '一枚旧怀表');

  assert.ok(
    mentioned.urgency > forgotten.urgency,
    `mentioned ${mentioned.urgency} should exceed forgotten ${forgotten.urgency}`
  );
  // The gap is exactly the mention term (capped at 0.2) — age is identical.
  assert.ok(
    Math.abs((mentioned.urgency - forgotten.urgency) - 0.2) < 1e-9,
    'the difference is the mention bonus, nothing else'
  );
});

// ── Persistence of prose ─────────────────────────────────────────────────────

test('retained prose survives a save/load round trip', async () => {
  const storage = new MemoryStorage();
  const { runtime } = makeRuntime({ storage });
  await loadWorld(runtime);
  await runtime.runTurn();

  await runtime.save('reader');
  assert.equal((await runtime.listSavedWorlds('reader'))[0].proseRecords, 1);

  const second = makeRuntime({ storage }).runtime;
  await second.load('reader');
  assert.equal(second.prose.size, 1);
  assert.equal(second.prose.get(1).text, '平淡的一回合。');
});

test('checkout restores the prose of that world line', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  await runtime.runTurn();
  const v1 = runtime.getState().canon.version;
  assert.equal(runtime.prose.size, 1);

  runtime.branch({ from: v1 });
  await runtime.runTurn();
  assert.equal(runtime.prose.size, 2);

  runtime.checkout(v1);
  assert.equal(runtime.prose.size, 1, 'the forked turn’s prose is not carried back');
});
