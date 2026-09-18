/**
 * P5 acceptance — character agents.
 *
 * DESIGN §9 P5: a character must be able to manufacture an event without player
 * involvement, and a `source: 'agent'` event must be adoptable by the director.
 * The two halves are tested separately: who acts is deterministic, what they do
 * needs a model, and a failing model must cost nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ELNRuntime } from '../src/runtime.js';
import { CharacterAgents, pickAgents, AGENT_EVENT_KIND } from '../src/orchestration/agents.js';
import { Director } from '../src/orchestration/director.js';
import { MemoryStorage } from '../src/memory/adapters/memory-storage.js';
import { genrePack } from '../src/expression/packs/genres/index.js';
import { stylePack } from '../src/expression/packs/styles/index.js';
import { FIXTURE_WORLD, sampleExtraction, sseResponse, sseChunks, jsonResponse } from './helpers.js';

const completionResponse = payload => jsonResponse({
  choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }],
});

/** A client that proposes one off-screen move per named character. */
const proposingAgent = names => ({
  complete: async prompt => JSON.stringify({
    actions: names
      .filter(n => prompt.includes(n))
      .map(n => ({ name: n, action: `${n}在暗中联络旧部` })),
  }),
});

/** The payload an agent model would return for a given prompt. */
const proposeFromPrompt = prompt => ({
  actions: ['李明远', '谢云舒', '赵鹏', '林默']
    .filter(name => prompt.includes(name))
    .map(name => ({ name, action: `${name}在暗中联络旧部` })),
});

function makeRuntime({ fetchOpts = {}, runtimeOpts = {}, storage = new MemoryStorage() } = {}) {
  let streamCalls = 0;
  const handler = async (url, init) => {
    const body = JSON.parse(init.body);
    fetchOpts.onBody?.(body);

    if (body.stream) {
      const script = fetchOpts.narratives ?? ['平淡的一回合。'];
      const text = script[Math.min(streamCalls, script.length - 1)];
      streamCalls += 1;
      return sseResponse(sseChunks([text]));
    }

    const prompt = body.messages[0].content;
    if (prompt.includes('世界名称')) return completionResponse(FIXTURE_WORLD);
    if (prompt.includes('幕后')) {
      // An explicit override lets a test simulate a broken or empty model.
      return completionResponse(fetchOpts.agent !== undefined ? fetchOpts.agent : proposeFromPrompt(prompt));
    }
    if (prompt.includes('连续性校对')) return completionResponse({ violations: [] });
    if (prompt.includes('戏剧顾问')) return completionResponse({});
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

/** Direct access to the state the agent layer reads. */
const seedState = runtime => {
  const state = runtime.getState();
  return { canon: state.canon, minds: state.minds, ledgers: { events: state.events, seeds: state.seeds } };
};

// ── Who acts (deterministic) ─────────────────────────────────────────────────

test('every living character with a goal is a candidate', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const { canon } = seedState(runtime);

  const picked = pickAgents(canon, 1, 3);
  assert.equal(picked.length, 3);
  for (const id of picked) {
    const entity = canon.entities.find(e => e.id === id);
    assert.equal(entity.alive, true);
    assert.ok(entity.goal);
  }
});

test('dead characters and characters without a goal cannot act', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const { canon } = seedState(runtime);

  canon.entities.find(e => e.name === '赵鹏').alive = false;
  canon.entities.find(e => e.name === '谢云舒').goal = '';

  const picked = pickAgents(canon, 1, 3);
  assert.deepEqual(picked, [canon.entities.find(e => e.name === '李明远').id]);
});

test('the player is excluded — they act through `action`, not off-screen', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const player = runtime.createPlayer({ name: '林默', goal: '查清名单' });
  const { canon } = seedState(runtime);

  const picked = pickAgents(canon, 1, 5, { excludeIds: [player.id] });
  assert.ok(!picked.includes(player.id));
});

test('selection rotates so the same characters are not always scheming', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const { canon } = seedState(runtime);

  const first = pickAgents(canon, 1, 2);
  const later = pickAgents(canon, 2, 2);
  assert.notDeepEqual(first, later, 'the rotation must move between turns');
});

test('selection is out of phase with the director’s mustAdvance', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const { canon, ledgers } = seedState(runtime);

  const beat = new Director().plan({ canon, ledgers });
  const agents = pickAgents(canon, canon.turn + 1, 2);

  assert.notDeepEqual(
    agents, beat.mustAdvance,
    'if the on-stage lead and the off-screen schemer were always the same, the layer would add nothing'
  );
});

test('no candidates means no work, not an error', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const { canon } = seedState(runtime);
  for (const e of canon.entities) e.alive = false;

  assert.deepEqual(pickAgents(canon, 1, 2), []);
});

// ── What they do (model) ─────────────────────────────────────────────────────

test('without a model the agent layer is inert', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const agents = new CharacterAgents();

  assert.equal(agents.canAct, false);
  const result = await agents.act(seedState(runtime));
  assert.deepEqual(result.events, []);
  assert.equal(result.modelChecked, false);
  assert.equal(result.actedIds.length, 0);
});

test('a model produces off-screen events attributed to their actor', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const state = seedState(runtime);

  const agents = new CharacterAgents({ client: proposingAgent(['李明远', '谢云舒']) });
  const result = await agents.act(state);

  assert.equal(result.modelChecked, true);
  assert.equal(result.events.length, result.actedIds.length);
  for (const event of result.events) {
    assert.equal(event.source, 'agent');
    assert.equal(event.kind, AGENT_EVENT_KIND);
    assert.equal(event.actors.length, 1);
    assert.match(event.summary, /在暗中联络旧部/);
  }
});

test('a proposal for an unknown or non-selected name is ignored', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  const agents = new CharacterAgents({
    client: { complete: async () => JSON.stringify({ actions: [{ name: '查无此人', action: '搞事' }] }) },
  });
  const result = await agents.act(seedState(runtime));

  assert.deepEqual(result.events, [], 'an invented actor cannot write to the ledger');
});

test('an empty action is not written to the ledger', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const state = seedState(runtime);

  const agents = new CharacterAgents({ client: proposingAgent(['李明远']) });
  const withBlank = new CharacterAgents({
    client: { complete: async () => JSON.stringify({ actions: [{ name: '李明远', action: '   ' }] }) },
  });

  assert.equal((await agents.act(state)).events.length, 1);
  assert.deepEqual((await withBlank.act(state)).events, []);
});

test('a failing or malformed agent model never throws', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const state = seedState(runtime);

  const throwing = new CharacterAgents({ client: { complete: async () => { throw new Error('down'); } } });
  const a = await throwing.act(state);
  assert.deepEqual(a.events, []);
  assert.match(a.error, /down/);

  const garbage = new CharacterAgents({ client: { complete: async () => '我想想……' } });
  assert.deepEqual((await garbage.act(state)).events, []);

  const wrongShape = new CharacterAgents({ client: { complete: async () => '{"actions":"nope"}' } });
  assert.deepEqual((await wrongShape.act(state)).events, []);
});

// ── Director adoption ────────────────────────────────────────────────────────

test('the director turns a recent off-screen move into an obligation', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const state = seedState(runtime);
  const li = runtime.getCharacter('李明远');

  state.ledgers.events.push({
    id: 'ev_agent_1', turn: 0, kind: 'offscreen', actors: [li.id],
    location: '', time: '', summary: '悄悄见了巡捕房的线人', source: 'agent',
  });

  const beat = new Director().plan({ canon: state.canon, ledgers: state.ledgers });

  assert.deepEqual(beat.adoptedAgentEvents, ['ev_agent_1']);
  const note = beat.constraintNotes.find(n => n.includes('悄悄见了巡捕房的线人'));
  assert.ok(note, 'the off-screen move reaches the beat');
  assert.match(note, /影响渗入场景/);
});

test('a stale off-screen move is not re-adopted forever', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const state = seedState(runtime);
  state.canon.turn = 5;

  state.ledgers.events.push({
    id: 'ev_agent_old', turn: 1, kind: 'offscreen', actors: [],
    location: '', time: '', summary: '很久以前的幕后动作', source: 'agent',
  });

  const beat = new Director().plan({ canon: state.canon, ledgers: state.ledgers });
  assert.deepEqual(beat.adoptedAgentEvents, []);
});

test('narrated events are never adopted as off-screen moves', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const state = seedState(runtime);

  state.ledgers.events.push({
    id: 'ev_narr', turn: 0, kind: 'action', actors: [], location: '', time: '',
    summary: '明面上的事', source: 'narrative',
  });

  const beat = new Director().plan({ canon: state.canon, ledgers: state.ledgers });
  assert.deepEqual(beat.adoptedAgentEvents, []);
});

// ── Runtime integration ──────────────────────────────────────────────────────

test('characters act automatically after a turn when an agent model is configured', async () => {
  const events = [];
  const { runtime } = makeRuntime({
    runtimeOpts: { models: { agent: 'cheap-model' }, onEvent: e => events.push(e) },
    fetchOpts: {},
  });
  await loadWorld(runtime);

  const result = await runtime.runTurn();

  assert.ok(result.betweenTurns, 'the hook ran');
  assert.ok(result.betweenTurns.events.length > 0, 'somebody acted');
  assert.ok(result.betweenTurns.actedIds.length > 0);

  const agentEvents = runtime.getState().events.filter(e => e.source === 'agent');
  assert.equal(agentEvents.length, result.betweenTurns.events.length);
  assert.ok(events.some(e => e.source === 'agent'), 'the caller is notified');

  assert.equal(runtime.getState().canon.turn, 1, 'the off-screen move does not advance the clock');
});

test('without an agent model no off-screen call is made', async () => {
  const prompts = [];
  const { runtime } = makeRuntime({
    fetchOpts: { onBody: b => prompts.push(b.messages[0].content) },
  });
  await loadWorld(runtime);

  const result = await runtime.runTurn();

  assert.equal(result.betweenTurns, undefined);
  assert.ok(!prompts.some(p => p.includes('幕后')), 'no agent prompt was sent');
  assert.deepEqual(runtime.getState().events.filter(e => e.source === 'agent'), []);
});

test('autoAgents can be turned off while keeping the model available', async () => {
  const { runtime } = makeRuntime({
    runtimeOpts: { models: { agent: 'cheap' }, autoAgents: false },
    fetchOpts: {},
  });
  await loadWorld(runtime);

  const result = await runtime.runTurn();
  assert.equal(result.betweenTurns, undefined, 'the automatic hook is disabled');

  const manual = await runtime.betweenTurns();
  assert.ok(manual.events.length > 0, 'the hook still works when called directly');
});

test('the manual hook commits a version so the move is durable', async () => {
  const { runtime } = makeRuntime({
    runtimeOpts: { models: { agent: 'cheap' } },
    fetchOpts: {},
  });
  await loadWorld(runtime);

  const before = runtime.history().length;
  await runtime.betweenTurns();

  assert.equal(runtime.history().length, before + 1);
  const restored = runtime.checkout(runtime.getState().canon.version);
  assert.ok(restored, 'the version is checkable');
});

test('a failing agent model does not lose the player their turn', async () => {
  const { runtime } = makeRuntime({
    runtimeOpts: { models: { agent: 'cheap' } },
    fetchOpts: { agent: '不是 JSON' },
  });
  await loadWorld(runtime);

  const result = await runtime.runTurn();

  assert.equal(result.summary, '李明远试探谢云舒，未果。', 'the turn completed normally');
  assert.equal(runtime.getState().canon.turn, 1);
  assert.deepEqual(result.betweenTurns.events, []);
});

test('the agent call is metered under its own role', async () => {
  const { runtime } = makeRuntime({
    runtimeOpts: { models: { agent: 'cheap' } },
    fetchOpts: {},
  });
  await loadWorld(runtime);
  runtime.resetUsage();

  const result = await runtime.runTurn();

  assert.ok(runtime.usage.byRole.agent.calls >= 1);
  assert.ok(result.usage.calls >= 3, 'narrative + extraction + agent');
});

test('an off-screen move from turn N is adopted into turn N+1’s prompt', async () => {
  const prompts = [];
  const { runtime } = makeRuntime({
    runtimeOpts: { models: { agent: 'cheap' } },
    fetchOpts: {
      onBody: body => { if (body.stream) prompts.push(body.messages[0].content); },
    },
  });
  await loadWorld(runtime);

  await runtime.runTurn();     // writes an agent event between turns
  await runtime.runTurn();     // should adopt it

  const agentSummary = runtime.getState().events.find(e => e.source === 'agent').summary;
  assert.match(prompts[1], /幕后：/, 'the second turn carries the off-screen obligation');
  assert.ok(prompts[1].includes(agentSummary), 'and names the actual move');
});

test('betweenTurns before a world is loaded gives an actionable error', async () => {
  const { runtime } = makeRuntime();
  await assert.rejects(() => runtime.betweenTurns(), /No world loaded/);
});
