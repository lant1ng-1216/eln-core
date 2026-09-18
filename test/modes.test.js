/**
 * P3 acceptance — dual mode.
 *
 * DESIGN §9 P3: switching to character mode must not leak privileged
 * information, and a player `action` must be able to enter canon. The two are
 * related: the player is an ordinary entity, so there is no "player privileges"
 * path for information to leak through.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ELNRuntime } from '../src/runtime.js';
import { TurnFailedError } from '../src/orchestration/turn.js';
import { Director } from '../src/orchestration/director.js';
import { MemoryStorage } from '../src/memory/adapters/memory-storage.js';
import { genrePack } from '../src/expression/packs/genres/index.js';
import { stylePack } from '../src/expression/packs/styles/index.js';
import { assembleContext } from '../src/expression/render.js';
import { compose } from '../src/expression/compose.js';
import { secretsOf, entityByName } from '../src/state/canon.js';
import { FIXTURE_WORLD, sampleExtraction, sseResponse, sseChunks, jsonResponse } from './helpers.js';

const completionResponse = payload => jsonResponse({
  choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }],
});

function makeRuntime({ fetchOpts = {}, runtimeOpts = {}, storage = new MemoryStorage() } = {}) {
  const handler = async (url, init) => {
    const body = JSON.parse(init.body);
    fetchOpts.onBody?.(body);
    if (body.stream) return sseResponse(sseChunks([fetchOpts.narrative ?? '平淡的一回合。']));
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

// ── POV rendering ────────────────────────────────────────────────────────────

test('director mode narrates omnisciently and emits no POV block', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  const state = runtime.getState();
  const blocks = assembleContext({ canon: state.canon, minds: state.minds, mode: 'director' });

  assert.equal(blocks.povBlock, '');
  assert.equal(blocks.trace.mode, 'director');
});

test('character mode writes from the holder’s limited view', async () => {
  let prompt = '';
  const { runtime } = makeRuntime({
    fetchOpts: { onBody: body => { if (body.stream) prompt = body.messages[0].content; } },
  });
  await loadWorld(runtime);

  const xie = runtime.getCharacter('谢云舒');
  runtime.setMode('character', xie.id);
  await runtime.runTurn();

  assert.match(prompt, /【叙事视角】/, 'a POV instruction is present');
  assert.match(prompt, new RegExp(`以${xie.name}的有限视角`));
  assert.match(prompt, /不得以旁白方式揭晓/, 'omniscient narration is explicitly banned');
  assert.match(prompt, /若谢云舒的认知有误，就按他的错误认知写/);
});

test('a character-mode prompt carries no secret the holder does not know', async () => {
  let prompt = '';
  const { runtime } = makeRuntime({
    fetchOpts: { onBody: body => { if (body.stream) prompt = body.messages[0].content; } },
  });
  await loadWorld(runtime);

  const xie = runtime.getCharacter('谢云舒');
  runtime.setMode('character', xie.id);
  await runtime.runTurn();

  assert.ok(!prompt.includes('实为地下党联络员'), '李明远’s secret leaked into 谢云舒’s prompt');
  assert.ok(!prompt.includes('早已被日谍收买'), '赵鹏’s secret leaked');
  assert.ok(!prompt.includes('客观设定·全部底牌'), 'the director-only block leaked');
  assert.ok(!prompt.includes('未回收的伏笔'), 'the author’s ledger leaked');
  assert.match(prompt, /替军统传递情报/, 'her own secret is legitimately visible');
});

test('the player’s own Mind is nothing special — no privileged path exists', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  const player = runtime.createPlayer({ name: '林默', role: '报馆记者', goal: '查清名单' });
  const mind = runtime.getState().minds.get(player.id);

  assert.deepEqual(mind.knows, [], 'a new player starts knowing nothing');
  assert.equal(runtime.getState().canon.facts.filter(f => f.tags.includes('secret')).length, 3,
    'adding a player does not change what secrets exist');
});

// ── Mode switching is lossless ───────────────────────────────────────────────

test('switching modes is a projection change, not a state change', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  await runtime.runTurn();

  const before = runtime.getState();
  const canonSnapshot = structuredClone(before.canon);
  const mindsSnapshot = structuredClone([...before.minds]);

  const xie = runtime.getCharacter('谢云舒');
  runtime.setMode('character', xie.id);

  const fromCharacter = runtime.getState();
  assert.deepEqual(fromCharacter.canon, canonSnapshot, 'canon is untouched by the mode');
  assert.deepEqual([...fromCharacter.minds], mindsSnapshot, 'minds are untouched by the mode');

  // A projected view is created on demand and does not replace the state.
  const view = runtime.getState({ perspective: xie.id });
  assert.equal(view.mode, 'character');
  assert.ok(view.hiddenFacts.length > 0);

  runtime.setMode('director');
  assert.deepEqual(runtime.getState().canon, canonSnapshot);
  assert.equal(runtime.mode, 'director');
});

test('character mode rejects an unknown player entity with guidance', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  assert.throws(
    () => runtime.setMode('character', 'nobody'),
    /createPlayer\(\) or pass an existing character id/
  );
  assert.equal(runtime.mode, 'director', 'the failed switch leaves the mode alone');
});

test('each mode can be entered after the other within one world', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const xie = runtime.getCharacter('谢云舒');

  runtime.setMode('character', xie.id);
  await runtime.runTurn();
  runtime.setMode('director');
  await runtime.runTurn();

  const state = runtime.getState();
  assert.equal(state.canon.turn, 2);
  assert.equal(state.turns.length, 2);
});

// ── Player entity ────────────────────────────────────────────────────────────

test('createPlayer adds an entity, a Mind and mutual trust edges', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  const player = runtime.createPlayer({ name: '林默', role: '报馆记者', personality: '固执', goal: '查清名单' });

  assert.equal(player.kind, 'character');
  assert.deepEqual(player.tags, ['player']);
  assert.equal(runtime.getCharacter('林默').id, player.id);

  const state = runtime.getState();
  const mind = state.minds.get(player.id);
  assert.ok(mind, 'the player has a Mind');
  assert.equal(Object.keys(mind.trust).length, 3, 'trust towards every existing character');

  for (const other of state.canon.entities.filter(e => e.kind === 'character' && e.id !== player.id)) {
    assert.ok(state.minds.get(other.id).trust[player.id], `${other.name} has trust towards the player`);
  }
});

test('createPlayer validates its input and commits a version', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  const versionsBefore = runtime.history().length;
  runtime.createPlayer({ name: '林默' });
  assert.equal(runtime.history().length, versionsBefore + 1, 'a version is committed');

  assert.throws(() => runtime.createPlayer({ name: '' }), /requires a name/);
  assert.throws(() => runtime.createPlayer({ name: '林默' }), /already exists/);
  assert.throws(() => runtime.createPlayer({ name: '林默' }), /already exists/);
});

// ── Player action ────────────────────────────────────────────────────────────

test('reviewAction accepts an ordinary action', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const player = runtime.createPlayer({ name: '林默' });

  const review = new Director().reviewAction('我撬开档案柜', {
    canon: runtime.getState().canon,
    playerEntityId: player.id,
  });
  assert.equal(review.allowed, true);
  assert.equal(review.action, '我撬开档案柜');
  assert.equal(review.reason, '');
});

test('reviewAction refuses a dead player and reports why', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const player = runtime.createPlayer({ name: '林默' });

  runtime.getState().canon.entities.find(e => e.id === player.id).alive = false;

  const review = new Director().reviewAction('我冲进巡捕房', {
    canon: runtime.getState().canon,
    playerEntityId: player.id,
  });
  assert.equal(review.allowed, false);
  assert.match(review.reason, /林默 已死亡/);
});

test('reviewAction refuses an action that involves a dead character', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const player = runtime.createPlayer({ name: '林默' });

  // Kill 赵鹏 through the state, then try to act on him.
  runtime.getState().canon.entities.find(e => e.name === '赵鹏').alive = false;

  const review = new Director().reviewAction('我去找赵鹏对质', {
    canon: runtime.getState().canon,
    playerEntityId: player.id,
  });
  assert.equal(review.allowed, false);
  assert.match(review.reason, /已死亡的角色：赵鹏/);
});

test('reviewAction passes an empty action through unchanged', () => {
  const review = new Director().reviewAction('   ', { canon: { entities: [] }, playerEntityId: 'p1' });
  assert.equal(review.allowed, true);
  assert.equal(review.action, '');
});

test('a rejected action aborts the turn before anything is written', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const player = runtime.createPlayer({ name: '林默' });
  runtime.setMode('character', player.id);
  runtime.getState().canon.entities.find(e => e.id === player.id).alive = false;

  await assert.rejects(() => runtime.runTurn({ action: '我冲出去' }), err => {
    assert.ok(err instanceof TurnFailedError);
    assert.equal(err.phase, 'action');
    assert.match(err.message, /已死亡/);
    return true;
  });

  assert.equal(runtime.getState().canon.turn, 0, 'no turn was committed');
  assert.equal(runtime.isRunning, false);
});

test('an action reaches the prompt as an obligation', async () => {
  let prompt = '';
  const { runtime } = makeRuntime({
    fetchOpts: { onBody: body => { if (body.stream) prompt = body.messages[0].content; } },
  });
  await loadWorld(runtime);
  const player = runtime.createPlayer({ name: '林默', goal: '查清名单' });
  runtime.setMode('character', player.id);

  await runtime.runTurn({ action: '我撬开档案柜，翻找名单' });

  assert.match(prompt, /玩家本回合的行动：我撬开档案柜，翻找名单/);
  assert.match(prompt, /必须让它在叙事中产生可见后果/);
  assert.match(prompt, /必须推进：林默、/, 'the player leads the must-advance list');
});

test('an action enters canon as a player-sourced event naming the actor', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const player = runtime.createPlayer({ name: '林默' });
  runtime.setMode('character', player.id);

  const result = await runtime.runTurn({ action: '我撬开档案柜' });

  const event = runtime.getState().events.find(e => e.source === 'player');
  assert.ok(event, 'the action is in the ledger');
  assert.equal(event.kind, 'action');
  assert.equal(event.summary, '我撬开档案柜');
  assert.deepEqual(event.actors, [player.id], 'the actor is traceable');
  assert.equal(result.action, '我撬开档案柜');
});

test('action is rejected in director mode, intervention in character mode', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  await assert.rejects(() => runtime.runTurn({ action: '我冲出去' }), /character-mode only/);

  const player = runtime.createPlayer({ name: '林默' });
  runtime.setMode('character', player.id);
  await assert.rejects(() => runtime.runTurn({ intervention: '天降陨石' }), /director-only/);
});

test('injectWorldEvent stays available in character mode without leaking', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const player = runtime.createPlayer({ name: '林默' });
  runtime.setMode('character', player.id);

  const mindsBefore = structuredClone([...runtime.getState().minds]);
  runtime.injectWorldEvent('城外的仓库起火了');

  const state = runtime.getState();
  assert.ok(state.events.some(e => e.summary === '城外的仓库起火了'));
  assert.deepEqual([...state.minds], mindsBefore, 'no one learned anything');
});

// ── Rendering in both modes from the same state ──────────────────────────────

test('the same state renders two different prompts', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const xie = runtime.getCharacter('谢云舒');
  const state = runtime.getState();

  const directorBlocks = assembleContext({ canon: state.canon, minds: state.minds, mode: 'director' });
  const characterBlocks = assembleContext({
    canon: state.canon, minds: state.minds, mode: 'character', holderId: xie.id,
  });

  const packs = [genrePack('republican'), stylePack('zh-literary')];
  const directorPrompt = compose(packs, directorBlocks, { turn: 1 });
  const characterPrompt = compose(packs, characterBlocks, { turn: 1 });

  assert.notEqual(directorPrompt, characterPrompt);
  assert.match(directorPrompt, /客观设定·全部底牌/);
  assert.ok(!characterPrompt.includes('客观设定·全部底牌'));
  assert.match(characterPrompt, /【叙事视角】/);
  assert.ok(!directorPrompt.includes('【叙事视角】'));

  // The genre voice is identical — only the lens differs.
  for (const prompt of [directorPrompt, characterPrompt]) {
    assert.match(prompt, /民国谍战/);
  }
});

test('a holder other than the player is projected by id, not by mode', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const li = runtime.getCharacter('李明远');
  const secret = secretsOf(runtime.getState().canon, entityByName(runtime.getState().canon, '谢云舒').id)[0];

  const view = runtime.getState({ perspective: li.id });
  assert.ok(!view.visibleFacts.some(f => f.id === secret.id), '李明远 does not know 谢云舒’s secret');
  assert.ok(view.hiddenFacts.some(f => f.id === secret.id));
});
