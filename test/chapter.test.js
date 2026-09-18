/**
 * P2 acceptance — chapter lifecycle and the director's seed logic.
 *
 * DESIGN §4 / §9 P2: seeds must be paid within their expected window, tension
 * must follow its curve, and chapters must close themselves. These tests cover
 * the deterministic machinery; the LLM-facing parts (`enrich`) are tested with
 * a fake client and must never be load-bearing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ELNRuntime } from '../src/runtime.js';
import {
  chapterBudgetExhausted, chapterProgress,
  evaluateCloseCriteria, closeChapter, maybeCloseChapter,
} from '../src/state/chapter.js';
import {
  Director, PAY_URGENCY_THRESHOLD, SEED_BUDGET, OVERDUE_AGE,
} from '../src/orchestration/director.js';
import { addSeed, recomputeUrgency } from '../src/state/ledger.js';
import { applyDelta } from '../src/state/commit.js';
import { tensionTargetFor, TENSION_BAND } from '../src/orchestration/director.js';
import { MemoryStorage } from '../src/memory/adapters/memory-storage.js';
import { genrePack } from '../src/expression/packs/genres/index.js';
import { stylePack } from '../src/expression/packs/styles/index.js';
import { makeState, FIXTURE_WORLD, sampleExtraction, sseResponse, sseChunks, jsonResponse } from './helpers.js';

const completionResponse = payload => jsonResponse({
  choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }],
});

function makeRuntime({ fetchOpts = {}, runtimeOpts = {}, storage = new MemoryStorage() } = {}) {
  let streamCalls = 0;
  const handler = async (url, init) => {
    const body = JSON.parse(init.body);
    fetchOpts.onBody?.(body);
    if (body.stream) {
      const script = fetchOpts.narratives;
      const text = script ? script[Math.min(streamCalls, script.length - 1)] : '平淡的一回合。';
      streamCalls += 1;
      return sseResponse(sseChunks([text]));
    }
    const prompt = body.messages[0].content;
    if (prompt.includes('世界名称')) return completionResponse(FIXTURE_WORLD);
    if (prompt.includes('戏剧顾问')) return completionResponse(fetchOpts.director ?? { complicate: '巡捕房上门盘查' });
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

// ── Budget and progress ──────────────────────────────────────────────────────

test('chapterProgress reports the fraction of the turn budget used', () => {
  const chapter = { completedTurns: 2, targetTurns: 8 };
  assert.equal(chapterProgress(chapter), 0.25);
  assert.equal(chapterProgress({ completedTurns: 20, targetTurns: 8 }), 1, 'clamped');
  assert.equal(chapterProgress({ completedTurns: 0, targetTurns: 0 }), 0);
  assert.equal(chapterProgress(null), 0);
});

test('the budget is exhausted only once the turns are actually spent', () => {
  assert.equal(chapterBudgetExhausted({ completedTurns: 4, targetTurns: 5 }), false);
  assert.equal(chapterBudgetExhausted({ completedTurns: 5, targetTurns: 5 }), true);
  assert.equal(chapterBudgetExhausted(null), false);
});

// ── Close criteria ───────────────────────────────────────────────────────────

test('a chapter with no declared criteria never closes on criteria', () => {
  const state = makeState();
  const result = evaluateCloseCriteria(state.canon, state.ledgers);

  assert.equal(result.declared, false);
  assert.equal(result.satisfied, false, 'no criteria must not read as "satisfied"');
});

test('declared criteria report what is met and what is missing', () => {
  const state = makeState();
  const paid = addSeed(state.ledgers, { id: 'sd_paid', plantedTurn: 0, text: '那封信' });
  addSeed(state.ledgers, { id: 'sd_open', plantedTurn: 0, text: '怀表' });
  paid.status = 'paid';

  state.canon.chapters[0].closeCriteria = {
    seedsToPay: ['sd_paid', 'sd_open'],
    goalsToMeet: ['找到失踪名单'],
  };
  // 李明远's goal is "找到失踪名单", so that criterion is met.
  state.canon.entities[0].goal = '找到失踪名单';

  const result = evaluateCloseCriteria(state.canon, state.ledgers);

  assert.equal(result.declared, true);
  assert.equal(result.satisfied, false);
  assert.ok(result.reasons.some(r => r.includes('那封信')));
  assert.ok(result.reasons.some(r => r.includes('找到失踪名单')));
  assert.ok(result.missing.some(m => m.includes('怀表')));
});

test('criteria are satisfied when every declared item is met', () => {
  const state = makeState();
  const seed = addSeed(state.ledgers, { id: 'sd_1', plantedTurn: 0, text: '那封信' });
  seed.status = 'paid';

  state.canon.chapters[0].closeCriteria = { seedsToPay: ['sd_1'], goalsToMeet: [] };

  const result = evaluateCloseCriteria(state.canon, state.ledgers);
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.missing, []);
});

// ── Closing ──────────────────────────────────────────────────────────────────

test('closeChapter activates the next chapter and does not mutate its input', () => {
  const state = makeState();
  state.canon.tension = 70;

  const before = structuredClone(state.canon);
  const out = closeChapter(state.canon, state.ledgers, { reason: 'criteria' });

  assert.equal(out.closed, true);
  assert.equal(out.canon.chapterIndex, 1);
  assert.equal(out.canon.chapters[0].status, 'done');
  assert.equal(out.canon.chapters[1].status, 'active');
  assert.equal(out.canon.tension, 42, 'tension resets between chapters');
  assert.deepEqual(state.canon, before, 'input canon untouched');
});

test('the final chapter cannot close — the story is over', () => {
  const state = makeState();
  state.canon.chapterIndex = state.canon.chapters.length - 1;

  const out = closeChapter(state.canon, state.ledgers);
  assert.equal(out.closed, false);
  assert.equal(out.reason, 'story complete');
});

test('maybeCloseChapter picks criteria over budget and reports why', () => {
  const state = makeState();
  const seed = addSeed(state.ledgers, { id: 'sd_1', plantedTurn: 0, text: '信' });
  seed.status = 'paid';
  state.canon.chapters[0].closeCriteria = { seedsToPay: ['sd_1'] };
  state.canon.chapters[0].completedTurns = 0;

  const out = maybeCloseChapter(state.canon, state.ledgers);
  assert.equal(out.closed, true);
  assert.equal(out.reason, 'criteria');
});

test('an exhausted budget closes the chapter when criteria never fired', () => {
  const state = makeState();
  state.canon.chapters[0].completedTurns = state.canon.chapters[0].targetTurns;

  const out = maybeCloseChapter(state.canon, state.ledgers);
  assert.equal(out.closed, true);
  assert.equal(out.reason, 'budget');
});

test('an early editor suggestion is ignored, a late one is honoured', () => {
  const state = makeState();

  state.canon.chapters[0].completedTurns = 1;
  assert.equal(maybeCloseChapter(state.canon, state.ledgers, { editorSuggested: true }).closed, false);

  state.canon.chapters[0].completedTurns = 4; // 4/5 = 0.8
  assert.equal(maybeCloseChapter(state.canon, state.ledgers, { editorSuggested: true }).closed, true);
});

// ── Director: seeds ──────────────────────────────────────────────────────────

test('a thread past the pay threshold is handed to the beat', () => {
  const state = makeState();
  const hot = addSeed(state.ledgers, { id: 'sd_hot', plantedTurn: 0, text: '那封信' });
  const cold = addSeed(state.ledgers, { id: 'sd_cold', plantedTurn: 0, text: '新线索' });
  hot.urgency = PAY_URGENCY_THRESHOLD;
  cold.urgency = 0.1;

  const beat = new Director().plan({ canon: state.canon, ledgers: state.ledgers });
  assert.deepEqual(beat.plantOrPay, ['sd_hot']);
});

test('an overdue thread escalates to a hard constraint note', () => {
  const state = makeState();
  state.canon.turn = OVERDUE_AGE + 2; // seed planted long ago
  addSeed(state.ledgers, { id: 'sd_old', plantedTurn: 1, text: '那封没寄出的信' });
  // Urgency is always recomputed at commit; do the same here so the seed carries
  // a real age term rather than the schema default of 0.
  recomputeUrgency(state.ledgers, { currentTurn: state.canon.turn });

  const beat = new Director().plan({ canon: state.canon, ledgers: state.ledgers });

  assert.ok(beat.overdue.includes('sd_old'));
  assert.ok(
    beat.constraintNotes.some(n => n.includes('那封没寄出的信') && n.includes('必须给出交代')),
    'an overdue thread becomes an explicit demand, not a quiet suggestion'
  );
});

test('new threads are planted only while the ledger has room', () => {
  const state = makeState();
  assert.equal(new Director().plan({ canon: state.canon, ledgers: state.ledgers }).plantCount, 1);

  for (let i = 0; i < SEED_BUDGET; i++) {
    addSeed(state.ledgers, { id: `sd_${i}`, plantedTurn: 0, text: `线 ${i}` });
  }
  assert.equal(
    new Director().plan({ canon: state.canon, ledgers: state.ledgers }).plantCount,
    0,
    'a crowded ledger stops growing'
  );
});

test('the seed budget tightens as the chapter closes', () => {
  const state = makeState();
  state.canon.chapters[0].completedTurns = state.canon.chapters[0].targetTurns;
  addSeed(state.ledgers, { id: 'sd_1', plantedTurn: 0, text: '线' });

  assert.equal(new Director().plan({ canon: state.canon, ledgers: state.ledgers }).plantCount, 0);
});

// ── Director: optional enrichment ────────────────────────────────────────────

test('without a model the beat stays deterministic and unenriched', async () => {
  const state = makeState();
  const director = new Director();
  const beat = director.plan({ canon: state.canon, ledgers: state.ledgers });

  assert.equal(director.canEnrich, false);
  assert.deepEqual(beat.mustComplicate, []);
  assert.equal(beat.enriched, undefined);

  const same = await director.enrich(beat, { canon: state.canon, ledgers: state.ledgers });
  assert.deepEqual(same, beat);
});

test('enrichment adds an obstacle and can change the hook kind', async () => {
  const state = makeState();
  const director = new Director({
    client: { complete: async () => '{"complicate":"巡捕房突然上门","hookKind":"反转"}' },
  });
  const beat = await director.enrich(
    director.plan({ canon: state.canon, ledgers: state.ledgers }),
    { canon: state.canon, ledgers: state.ledgers }
  );

  assert.deepEqual(beat.mustComplicate, ['巡捕房突然上门']);
  assert.equal(beat.hookKind, '反转');
  assert.equal(beat.enriched, true);
});

test('a failing or malformed advisor never breaks the beat', async () => {
  const state = makeState();
  const ctx = { canon: state.canon, ledgers: state.ledgers };
  const plan = () => new Director().plan({ canon: state.canon, ledgers: state.ledgers });

  const throwing = new Director({ client: { complete: async () => { throw new Error('boom'); } } });
  assert.deepEqual(await throwing.enrich(plan(), ctx), plan());

  const garbage = new Director({ client: { complete: async () => '我建议……嗯，不好说' } });
  assert.deepEqual(await garbage.enrich(plan(), ctx), plan());

  const partial = new Director({ client: { complete: async () => '{"hookKind":"不存在的类型"}' } });
  const out = await partial.enrich(plan(), ctx);
  assert.equal(out.hookKind, plan().hookKind, 'an unknown hook kind is rejected');
});

// ── End to end ───────────────────────────────────────────────────────────────

test('a chapter closes itself once its promised seed is paid', async () => {
  const transitions = [];
  const seedId = 'sd_authored_1';
  const { runtime } = makeRuntime({
    fetchOpts: { extraction: sampleExtraction({ seed_payoffs: [{ seedId }] }) },
    runtimeOpts: { onChapterEnd: t => transitions.push(t) },
  });
  await loadWorld(runtime);

  const seed = runtime.plantSeed('那封没有署名的信是谁送的');
  assert.equal(seed.id, seedId);
  runtime.getState().canon.chapters[0].closeCriteria = { seedsToPay: [seedId] };

  const result = await runtime.runTurn();

  assert.deepEqual(result.chapterTransition, {
    reason: 'criteria',
    from: '第一章 失踪',
    to: '第二章 交锋',
    index: 1,
  });
  assert.equal(runtime.getState().canon.chapterIndex, 1);
  assert.equal(runtime.listSeeds({ status: 'paid' }).length, 1, 'the seed was paid');
  assert.equal(transitions.length, 1, 'onChapterEnd fired once');
  assert.ok(
    runtime.getState().events.some(e => e.kind === 'world' && e.summary.includes('收尾')),
    'the transition is recorded in the ledger'
  );
});

test('a chapter closes on budget exhaustion across turns', async () => {
  const transitions = [];
  const { runtime } = makeRuntime({ runtimeOpts: { onChapterEnd: t => transitions.push(t) } });
  await loadWorld(runtime);
  runtime.getState().canon.chapters[0].targetTurns = 2;

  const first = await runtime.runTurn();
  assert.equal(first.chapterTransition, null, 'one turn is not a chapter');

  const second = await runtime.runTurn();
  assert.equal(second.chapterTransition.reason, 'budget');
  assert.equal(runtime.getState().canon.chapterIndex, 1);
  assert.equal(transitions.length, 1);
});

test('the director hands a due seed to the model as a demand', async () => {
  let prompt = '';
  const { runtime } = makeRuntime({
    fetchOpts: { onBody: body => { if (body.stream) prompt = body.messages[0].content; } },
  });
  await loadWorld(runtime);

  const seed = runtime.plantSeed('那封没有署名的信');
  seed.urgency = 0.9; // force it due

  await runtime.runTurn();

  assert.match(prompt, /必须回收伏笔：/, 'a due thread is an obligation, not a hint');
  assert.match(prompt, /那封没有署名的信/);
  assert.match(prompt, /需埋下 1 条新的伏笔/);
});

test('the director model is optional and only consulted when configured', async () => {
  const bodies = [];
  const { runtime } = makeRuntime({
    fetchOpts: { onBody: b => bodies.push(b.messages[0].content) },
  });
  await loadWorld(runtime);
  await runtime.runTurn();

  assert.ok(!bodies.some(p => p.includes('戏剧顾问')), 'no director model configured, no advisory call');
});

test('a configured director model contributes the obstacle', async () => {
  let prompt = '';
  const { runtime } = makeRuntime({
    runtimeOpts: { models: { director: 'cheap-model' } },
    fetchOpts: { onBody: body => { if (body.stream) prompt = body.messages[0].content; } },
  });
  await loadWorld(runtime);
  const result = await runtime.runTurn();

  assert.equal(result.beatSpec.enriched, true);
  assert.deepEqual(result.beatSpec.mustComplicate, ['巡捕房上门盘查']);
  assert.match(prompt, /必须制造阻碍：巡捕房上门盘查/);
});

// ── Tension convergence ──────────────────────────────────────────────────────

test('observed tension converges on the curve instead of drifting (差驱动)', () => {
  const state = makeState();
  const chapter = state.canon.chapters[0];
  chapter.targetTurns = 20;
  state.canon.tension = 5; // far below the curve

  const curveAt = progress => 25 + progress * 45;
  const gaps = [];
  let canon = state.canon;

  for (let i = 0; i < 6; i++) {
    const target = tensionTargetFor(canon, canon.chapters[0]);
    const curve = curveAt(canon.chapters[0].completedTurns / 20);
    gaps.push(Math.abs(canon.tension - curve));

    // Simulate a model that complies exactly with the director's target.
    canon = applyDelta({
      canon,
      minds: state.minds,
      ledgers: state.ledgers,
      delta: { world: { tension: target } },
    }).canon;
  }

  assert.ok(gaps[0] > 15, `a cold opening starts far off the curve (got ${gaps[0]})`);
  assert.ok(
    gaps[gaps.length - 1] < 3,
    `the observed value should end near the curve (gap ${gaps[gaps.length - 1]})`
  );
  assert.ok(
    gaps[gaps.length - 1] < gaps[0],
    'the gap must shrink, not drift'
  );
});

test('a story running hot is pulled back toward the curve', () => {
  const state = makeState();
  const chapter = state.canon.chapters[0];
  chapter.targetTurns = 20;
  chapter.completedTurns = 1;
  state.canon.tension = 95;

  const target = tensionTargetFor(state.canon, chapter);
  assert.ok(target < 30, `a hot story gets a cool target (got ${target})`);
});

// ── The band: keeping the observation near the intent ────────────────────────
//
// A real-model run showed observations sitting 30-40 points above the target
// indefinitely: `tensionTargetFor` steered the intent, but nothing pulled the
// observed value, so the two never converged. These lock the closed loop.

/**
 * Commit a turn whose extraction reports `tension`, under a given target.
 * `from` sets the starting value so the tests isolate the band from the
 * per-turn smoothing (the observed value can only move 20 per turn).
 */
function observeTension({ from = 30, tension, target = null, band = null, chapter }) {
  const state = makeState();
  state.canon.tension = from;
  if (chapter) Object.assign(state.canon.chapters[0], chapter);
  return applyDelta({
    canon: state.canon,
    minds: state.minds,
    ledgers: state.ledgers,
    delta: { world: { tension } },
    tensionTarget: target,
    tensionBand: band,
  });
}

test('an observation inside the band stands as the actual value', () => {
  const out = observeTension({ from: 50, tension: 58, target: 50, band: 20 });

  assert.equal(out.canon.tension, 58, 'no override inside the band');
  assert.equal(out.turnRecord.tensionClamp, undefined, 'nothing to report');
});

test('an observation exactly at the band edge is left alone', () => {
  const out = observeTension({ from: 70, tension: 70, target: 50, band: 20 });
  assert.equal(out.canon.tension, 70);
  assert.equal(out.turnRecord.tensionClamp, undefined);
});

test('an observation beyond the band is reeled back and the override is recorded', () => {
  const out = observeTension({ from: 90, tension: 90, target: 50, band: 20 });

  assert.equal(out.canon.tension, 70, 'clamped to target + band');
  assert.deepEqual(out.turnRecord.tensionClamp, {
    observed: 90, applied: 70, target: 50, band: 20,
  });
});

test('the band works downward too — a cold reading is pulled up', () => {
  const out = observeTension({ from: 5, tension: 5, target: 40, band: 20 });

  assert.equal(out.canon.tension, 20, 'clamped to target - band');
  assert.equal(out.turnRecord.tensionClamp.applied, 20);
});

test('without a target nothing is clamped — direct applyDelta is unchanged', () => {
  const out = observeTension({ from: 90, tension: 90 });
  assert.equal(out.canon.tension, 90);
  assert.equal(out.turnRecord.tensionClamp, undefined);
});

test('a zero band makes the target authoritative', () => {
  const out = observeTension({ tension: 90, target: 50, band: 0 });
  assert.equal(out.canon.tension, 50);
});

test('repeated observations converge into the band instead of drifting', () => {
  // The failure mode from the real run: readings far above the curve, forever.
  const state = makeState();
  state.canon.chapters[0].targetTurns = 20;

  const curve = { start: 25, end: 70 };
  let canon = state.canon;
  const gaps = [];

  for (let i = 0; i < 6; i++) {
    const target = tensionTargetFor(canon, canon.chapters[0], curve);
    // A model that stubbornly reports "maximally tense" every turn.
    const out = applyDelta({
      canon,
      minds: state.minds,
      ledgers: state.ledgers,
      delta: { world: { tension: 95 } },
      tensionTarget: target,
      tensionBand: TENSION_BAND,
    });
    canon = out.canon;
    gaps.push(Math.abs(canon.tension - target));
  }

  assert.ok(gaps[0] <= TENSION_BAND, `first turn is already bounded (gap ${gaps[0]})`);
  assert.ok(
    gaps.every(g => g <= TENSION_BAND),
    `every gap must stay within the band: ${gaps.join(', ')}`
  );
});

test('the band and the curve are configuration, not constants', () => {
  const state = makeState();
  state.canon.tension = 30;

  const tight = new Director({ tensionBand: 5, tensionCurve: { start: 10, end: 20 } });
  const wide = new Director({ tensionBand: 40 });

  const tightBeat = tight.plan({ canon: state.canon, ledgers: state.ledgers });
  const wideBeat = wide.plan({ canon: state.canon, ledgers: state.ledgers });

  assert.equal(tightBeat.tensionBand, 5);
  assert.equal(wideBeat.tensionBand, 40);
  assert.ok(
    tightBeat.tensionTarget < wideBeat.tensionTarget,
    `a lower curve yields a lower target (${tightBeat.tensionTarget} < ${wideBeat.tensionTarget})`
  );
});
