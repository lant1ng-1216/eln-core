/**
 * P0 acceptance — the runtime facade, end to end.
 *
 * Uses a fake `fetch` throughout, so no network and no API key. The two
 * headline regressions under test:
 *  - a failed turn must not drift `canon.turn` / `chapter.completedTurns`;
 *  - `save()` must work on Node, where there is no `localStorage` global.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ELNRuntime } from '../src/runtime.js';
import { TurnFailedError } from '../src/orchestration/turn.js';
import { MemoryStorage } from '../src/memory/adapters/memory-storage.js';
import { genrePack } from '../src/expression/packs/genres/index.js';
import { stylePack } from '../src/expression/packs/styles/index.js';
import {
  FIXTURE_WORLD, SAMPLE_NARRATIVE, sampleExtraction,
  sseResponse, sseChunks, jsonResponse,
} from './helpers.js';

/**
 * Wrap a payload in the OpenAI-compatible completion envelope, which is what
 * `LLMClient.complete` unwraps (`choices[0].message.content`).
 */
const completionResponse = payload => jsonResponse({
  choices: [{
    message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) },
  }],
});

/**
 * Fake transport. Routes on the request body: streaming requests get SSE,
 * everything else gets JSON — world-gen when the prompt asks for a world,
 * extraction otherwise.
 */
function makeFetch({
  world = FIXTURE_WORLD,
  extraction = sampleExtraction(),
  extractionSequence = null,
  narrative = SAMPLE_NARRATIVE,
  failExtraction = false,
  failStream = false,
  onBody,
} = {}) {
  let extractionCalls = 0;

  return async (url, init) => {
    const body = JSON.parse(init.body);
    onBody?.(body);

    if (body.stream) {
      if (failStream) throw new Error('stream connection reset');
      return sseResponse(sseChunks([narrative]));
    }

    const prompt = body.messages[0].content;
    if (prompt.includes('世界名称')) return completionResponse(world);

    if (failExtraction) throw new Error('extraction endpoint unreachable');

    if (extractionSequence) {
      const item = extractionSequence[Math.min(extractionCalls, extractionSequence.length - 1)];
      extractionCalls += 1;
      return completionResponse(item);
    }
    return completionResponse(extraction);
  };
}

function makeRuntime({ fetchOpts = {}, runtimeOpts = {}, storage = new MemoryStorage() } = {}) {
  const runtime = new ELNRuntime({
    apiKey: 'test-key',
    apiBase: 'https://example.invalid',
    packs: [genrePack('republican'), stylePack('zh-literary')],
    storage,
    fetchImpl: makeFetch(fetchOpts),
    ...runtimeOpts,
  });
  return { runtime, storage };
}

const loadWorld = async runtime => {
  const world = await runtime.generateWorld({ genre: 'republican' });
  runtime.loadWorld(world);
  return world;
};

// ── World generation & loading ───────────────────────────────────────────────

test('generateWorld validates the model output and does not load it', async () => {
  const { runtime } = makeRuntime();

  const world = await runtime.generateWorld({ genre: 'republican' });
  assert.equal(world.name, '雾港');
  assert.equal(world.characters.length, 3);
  assert.equal(runtime.isWorldLoaded, false, 'generation must not implicitly load');
});

test('generateWorld rejects a malformed world payload', async () => {
  const { runtime } = makeRuntime({ fetchOpts: { world: { name: '缺角色' } } });
  await assert.rejects(() => runtime.generateWorld({ genre: 'republican' }), /Invalid GeneratedWorld/);
});

test('loadWorld initializes canon, minds, ledgers and a version store', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  const state = runtime.getState();
  assert.equal(runtime.isWorldLoaded, true);
  assert.equal(state.canon.turn, 0);
  assert.equal(state.canon.facts.filter(f => f.tags.includes('secret')).length, 3);
  assert.ok(state.minds instanceof Map);
  assert.equal(state.minds.size, 3);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.seeds, []);
  assert.equal(runtime.history().length, 1);
});

// ── A successful turn ────────────────────────────────────────────────────────

test('runTurn commits narrative, state changes, events and knowledge', async () => {
  const tokens = [];
  const results = [];
  const events = [];
  const { runtime } = makeRuntime({
    runtimeOpts: {
      onToken: t => tokens.push(t),
      onTurnEnd: r => results.push(r),
      onEvent: e => events.push(e),
    },
  });
  await loadWorld(runtime);

  const result = await runtime.runTurn();

  assert.equal(result.turn, 1);
  assert.equal(result.summary, '李明远试探谢云舒，未果。');
  assert.equal(tokens.join(''), SAMPLE_NARRATIVE, 'every streamed token reaches the caller');
  assert.equal(results.length, 1);
  assert.equal(events.length, 1, 'the new event is announced');

  const state = runtime.getState();
  assert.equal(state.canon.turn, 1);
  assert.equal(state.canon.location, '霞飞路舞厅');
  assert.equal(state.canon.time, '深夜');
  // The extraction reported 45, but the director's target for this beat was 23,
  // so the observation is reined back to the edge of the band (23 + 20).
  assert.equal(state.canon.tension, 43);
  assert.deepEqual(state.turns[0].tensionClamp, { observed: 45, applied: 43, target: 23, band: 20 });
  assert.equal(result.turnRecord, state.turns[0], 'the result exposes the persisted record');
  assert.equal(state.canon.chapters[0].completedTurns, 1);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].source, 'narrative');
  assert.equal(state.seeds.length, 1);
  assert.equal(state.turns.length, 1);

  // The extracted fact was committed and the declared stance applied.
  const fact = state.canon.facts.find(f => f.object === '失踪名单');
  assert.ok(fact, 'extracted fact committed');
  const liId = state.canon.entities.find(e => e.name === '李明远').id;
  assert.ok(state.minds.get(liId).knows.some(r => r.factId === fact.id), 'knowledge applied');
});

test('the director’s beat and constraints reach the narrative prompt', async () => {
  let narrativePrompt = '';
  const { runtime } = makeRuntime({
    fetchOpts: {
      onBody: body => {
        if (body.stream) narrativePrompt = body.messages[0].content;
      },
    },
  });
  await loadWorld(runtime);
  await runtime.runTurn();

  assert.match(narrativePrompt, /本回合戏剧任务/);
  assert.match(narrativePrompt, /张力目标：/);
  assert.match(narrativePrompt, /【角色状态】/);
  assert.match(narrativePrompt, /民国谍战/);
  assert.ok(!narrativePrompt.includes('历史谍战小说'), 'the 0.1.0 hardcode must not return');
});

test('an intervention is recorded as a director-sourced event', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  await runtime.runTurn({ intervention: '一封匿名信被塞进门缝' });

  const state = runtime.getState();
  const intervention = state.events.find(e => e.kind === 'intervention');
  assert.ok(intervention);
  assert.equal(intervention.source, 'director');
  assert.equal(intervention.summary, '一封匿名信被塞进门缝');
});

// ── Failure semantics (the drift bug) ────────────────────────────────────────

test('a hard extraction failure rolls the whole turn back — counters do not drift', async () => {
  const { runtime } = makeRuntime({ fetchOpts: { failExtraction: true } });
  await loadWorld(runtime);

  await assert.rejects(() => runtime.runTurn(), err => {
    assert.ok(err instanceof TurnFailedError);
    assert.equal(err.phase, 'extraction');
    return true;
  });

  const state = runtime.getState();
  assert.equal(state.canon.turn, 0, 'turn must not advance');
  assert.equal(state.canon.chapters[0].completedTurns, 0, 'chapter counter must not advance');
  assert.equal(state.events.length, 0);
  assert.equal(state.turns.length, 0);
  assert.equal(runtime.history().length, 1, 'no version is committed');
  assert.equal(runtime.isRunning, false, 'the running flag is released');
});

test('a streaming failure also rolls back cleanly', async () => {
  const { runtime } = makeRuntime({ fetchOpts: { failStream: true } });
  await loadWorld(runtime);

  await assert.rejects(() => runtime.runTurn(), err => {
    assert.ok(err instanceof TurnFailedError);
    assert.equal(err.phase, 'narrative');
    return true;
  });
  assert.equal(runtime.getState().canon.turn, 0);
});

test('a retry after a failed turn still works (the flag is not stuck)', async () => {
  const { runtime } = makeRuntime({ fetchOpts: { failStream: true } });
  await loadWorld(runtime);
  await assert.rejects(() => runtime.runTurn());
  await assert.rejects(() => runtime.runTurn());
  assert.equal(runtime.isRunning, false);
});

test('an unparseable extraction is repaired and then committed degraded', async () => {
  const { runtime } = makeRuntime({
    fetchOpts: { extractionSequence: ['不是 JSON', '还是不是 JSON'] },
  });
  await loadWorld(runtime);

  const result = await runtime.runTurn();

  assert.equal(result.repairAttempts, 2, 'one repair attempt was made');
  assert.deepEqual(result.degraded, ['root']);
  assert.equal(runtime.getState().canon.turn, 1, 'the turn still commits');
  assert.equal(runtime.getState().events.length, 0, 'but nothing was extracted');
});

test('a partially invalid extraction is repaired block by block', async () => {
  const { runtime } = makeRuntime({
    fetchOpts: {
      extractionSequence: [
        { summary: '半成品', characters: '这不是数组' },   // characters block invalid
        sampleExtraction(),                                // repaired
      ],
    },
  });
  await loadWorld(runtime);

  const result = await runtime.runTurn();

  assert.equal(result.repairAttempts, 2);
  assert.deepEqual(result.degraded, [], 'the retry recovered the lost block');
  assert.equal(result.delta.characters.length, 2);
  const li = runtime.getCharacter('李明远');
  assert.equal(li.emotion, '警觉', 'the repaired block was applied');
});

test('a degraded extraction is reported on the turn record', async () => {
  const { runtime } = makeRuntime({
    fetchOpts: { extraction: { summary: '仅有摘要' } },
  });
  await loadWorld(runtime);

  const result = await runtime.runTurn();
  assert.equal(result.degraded.length > 0, false, 'a summary-only payload has no invalid block');
  assert.equal(runtime.getState().turns[0].summary, '仅有摘要');
});

// ── Perspective ──────────────────────────────────────────────────────────────

test('getState({perspective}) returns a projected view with no leaked secrets', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  const xie = runtime.getCharacter('谢云舒');
  const view = runtime.getState({ perspective: xie.id });

  assert.equal(view.mode, 'character');
  assert.equal(view.holder.name, '谢云舒');
  assert.ok(view.visibleFacts.some(f => f.object === '替军统传递情报'), 'own secret visible');
  assert.ok(!view.visibleFacts.some(f => f.object === '实为地下党联络员'), 'other secret hidden');
  assert.ok(view.hiddenFacts.length >= 1);
});

// ── Modes ────────────────────────────────────────────────────────────────────

test('intervention is rejected in character mode', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  runtime.setMode('character', runtime.getCharacter('谢云舒').id);

  await assert.rejects(
    () => runtime.runTurn({ intervention: '天降陨石' }),
    /director-only/
  );
});

test('character mode requires a player entity', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  assert.throws(() => runtime.setMode('character'), /requires a playerEntityId/);
  assert.throws(() => runtime.setMode('god'), /Unknown mode/);
});

test('a player action enters the ledger as a player-sourced event', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  runtime.setMode('character', runtime.getCharacter('李明远').id);

  await runtime.runTurn({ action: '我潜入赵鹏的办公室' });

  const event = runtime.getState().events.find(e => e.source === 'player');
  assert.ok(event);
  assert.equal(event.summary, '我潜入赵鹏的办公室');
});

test('injectWorldEvent changes the world without leaking knowledge to anyone', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  const xieId = runtime.getCharacter('谢云舒').id;
  const before = runtime.getState().minds.get(xieId).knows.length;

  runtime.injectWorldEvent('城外传来爆炸声');

  const state = runtime.getState();
  const injected = state.events.find(e => e.summary === '城外传来爆炸声');
  assert.ok(injected);
  assert.equal(injected.source, 'director');
  for (const mind of state.minds.values()) {
    assert.equal(mind.knows.length, before, 'no character learns anything from a world event');
  }
});

// ── God mode ─────────────────────────────────────────────────────────────────

test('forceSecretReveal writes knowledge instead of patching the prompt', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  const xieId = runtime.getCharacter('谢云舒').id;
  const liSecret = runtime.getState().canon.facts.find(f => f.object === '实为地下党联络员');
  assert.ok(!runtime.getState().minds.get(xieId).knows.some(r => r.factId === liSecret.id));

  const out = runtime.forceSecretReveal('李明远', '谢云舒');

  assert.deepEqual(out.revealed, ['实为地下党联络员']);
  assert.ok(runtime.getState().minds.get(xieId).knows.some(r => r.factId === liSecret.id));
});

test('forceSecretReveal rejects unknown characters', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  assert.throws(() => runtime.forceSecretReveal('不存在', '谢云舒'), /Character not found/);
});

test('nextChapter advances the cursor and reports the end of the story', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  assert.equal(runtime.getState().canon.chapterIndex, 0);
  assert.equal(runtime.nextChapter('聚焦信任危机'), true);

  const state = runtime.getState();
  assert.equal(state.canon.chapterIndex, 1);
  assert.equal(state.canon.chapters[0].status, 'done');
  assert.equal(state.canon.chapters[1].status, 'active');

  assert.equal(runtime.nextChapter(), false, 'no third chapter exists');
});

// ── Branching ────────────────────────────────────────────────────────────────

test('branch and checkout expose two world lines without copying', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  await runtime.runTurn();
  const v1 = runtime.getState().canon.version;

  runtime.branch({ from: v1 });
  await runtime.runTurn();
  assert.equal(runtime.getState().canon.turn, 2);

  runtime.checkout(v1);
  assert.equal(runtime.getState().canon.turn, 1, 'restored to the branch point');
  assert.equal(runtime.history().length, 2);
});

// ── Persistence (the Node ReferenceError) ────────────────────────────────────

test('save() works on Node, where there is no localStorage global', async () => {
  const storage = new MemoryStorage();
  const { runtime } = makeRuntime({ storage });
  await loadWorld(runtime);
  await runtime.runTurn();

  const worldId = await runtime.save('user-1');
  assert.equal(worldId, runtime.getState().canon.id);

  const list = await runtime.listSavedWorlds('user-1');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '雾港');
  assert.equal(list[0].turn, 1);
  assert.equal(list[0].charCount, 3);
});

test('a saved world round-trips through a fresh runtime', async () => {
  const storage = new MemoryStorage();
  const first = makeRuntime({ storage }).runtime;
  await loadWorld(first);
  await first.runTurn();
  await first.save('user-2');

  const second = makeRuntime({ storage }).runtime;
  const restored = await second.load('user-2');

  assert.equal(restored.canon.turn, 1);
  assert.equal(restored.canon.location, '霞飞路舞厅');
  assert.equal(restored.minds.size, 3);
  assert.equal(restored.seeds.length, 1);
  assert.equal(restored.turns.length, 1);
  assert.equal(second.isWorldLoaded, true);
});

test('load() reports a miss instead of throwing', async () => {
  const { runtime } = makeRuntime();
  assert.equal(await runtime.load('nobody'), null);
});

test('the static list helper works without a runtime instance', async () => {
  const storage = new MemoryStorage();
  const { runtime } = makeRuntime({ storage });
  await loadWorld(runtime);
  await runtime.save('user-3');

  const list = await ELNRuntime.getSavedWorlds('user-3', storage);
  assert.equal(list.length, 1);
});

test('deleteSavedWorld removes a world', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const id = await runtime.save('user-4');

  assert.equal(await runtime.deleteSavedWorld('user-4', id), true);
  assert.deepEqual(await runtime.listSavedWorlds('user-4'), []);
});

test('a corrupted save fails loudly at the boundary on load', async () => {
  const storage = new MemoryStorage();
  const { runtime } = makeRuntime({ storage });
  await loadWorld(runtime);
  await runtime.save('user-5');

  // Sabotage the stored canon.
  const raw = JSON.parse(await storage.get('worlds:user-5'));
  raw[0].snapshot.canon.tension = 9999;
  await storage.set('worlds:user-5', JSON.stringify(raw));

  const second = makeRuntime({ storage }).runtime;
  await assert.rejects(() => second.load('user-5'), /Invalid Canon/);
});

// ── Guards ───────────────────────────────────────────────────────────────────

test('runTurn before loadWorld gives an actionable error', async () => {
  const { runtime } = makeRuntime();
  await assert.rejects(() => runtime.runTurn(), /No world loaded/);
});

test('listSeeds filters by status and getOpenSeeds sorts by urgency', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  await runtime.runTurn();

  assert.equal(runtime.listSeeds({ status: 'open' }).length, 1);
  assert.equal(runtime.listSeeds({ status: 'paid' }).length, 0);
  assert.equal(runtime.listSeeds({ status: null }).length, 1);
  assert.equal(runtime.getOpenSeeds().length, 1);
});
