/**
 * P0 acceptance — director layer (deterministic core).
 *
 * P2 grows the director into full beat planning. What must hold from P0 is that
 * the tension curve and the error feedback are *deterministic* and never asked
 * of the LLM (DESIGN §4).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Director, tensionTargetFor, HOOK_KINDS } from '../src/orchestration/director.js';
import { addSeed } from '../src/state/ledger.js';
import { makeState } from './helpers.js';

/** Move the chapter forward without touching the rest of the state. */
function withProgress(state, completedTurns, tension) {
  state.canon.chapters[0].completedTurns = completedTurns;
  if (tension !== undefined) state.canon.tension = tension;
  return state;
}

test('the tension curve rises across a chapter', () => {
  const state = makeState();
  const early = tensionTargetFor(withProgress(state, 0).canon, state.canon.chapters[0]);
  const mid = tensionTargetFor(withProgress(state, 2).canon, state.canon.chapters[0]);
  const late = tensionTargetFor(withProgress(state, 5).canon, state.canon.chapters[0]);

  assert.ok(early < mid, `${early} < ${mid}`);
  assert.ok(mid < late, `${mid} < ${late}`);
  assert.ok(late <= 95);
});

test('a story running colder than the curve gets a higher target (差驱动)', () => {
  const state = makeState();
  const chapter = state.canon.chapters[0];

  const onCurve = tensionTargetFor(withProgress(state, 3, 47).canon, chapter);
  const lagging = tensionTargetFor(withProgress(state, 3, 10).canon, chapter);
  const ahead = tensionTargetFor(withProgress(state, 3, 90).canon, chapter);

  assert.ok(lagging > onCurve, 'lagging prose pushes the target up');
  assert.ok(ahead < onCurve, 'running hot pulls the target back');
});

test('tension targets are always within the valid band', () => {
  const state = makeState();
  const chapter = state.canon.chapters[0];
  for (const actual of [0, 25, 50, 75, 100]) {
    for (const progress of [0, 1, 3, 5, 10]) {
      const target = tensionTargetFor(withProgress(state, progress, actual).canon, chapter);
      assert.ok(target >= 5 && target <= 95, `target ${target} out of band`);
      assert.equal(Number.isInteger(target), true);
    }
  }
});

test('plan produces a complete BeatSpec', () => {
  const state = makeState();
  const beat = new Director().plan({ canon: state.canon, ledgers: state.ledgers });

  assert.ok(Array.isArray(beat.mustAdvance));
  assert.ok(Array.isArray(beat.mustComplicate));
  assert.ok(Array.isArray(beat.plantOrPay));
  assert.ok(Array.isArray(beat.constraintNotes));
  assert.equal(typeof beat.tensionTarget, 'number');
  assert.ok(HOOK_KINDS.includes(beat.hookKind));
});

test('protagonists are selected to advance before supporting cast', () => {
  const state = makeState();
  const beat = new Director().plan({ canon: state.canon, ledgers: state.ledgers });

  // 李明远 (男主) and 谢云舒 (女主) outrank 赵鹏 (反派).
  const zhao = state.canon.entities.find(e => e.name === '赵鹏').id;
  assert.ok(beat.mustAdvance.includes(state.canon.entities.find(e => e.name === '李明远').id));
  assert.ok(!beat.mustAdvance.includes(zhao));
});

test('only urgent seeds are handed to the beat', () => {
  const state = makeState();
  const cold = addSeed(state.ledgers, { id: 'sd_cold', plantedTurn: 99, text: '刚刚埋下' });
  const hot = addSeed(state.ledgers, { id: 'sd_hot', plantedTurn: 0, text: '早就埋下' });
  cold.urgency = 0;
  hot.urgency = 0.8;

  const beat = new Director().plan({ canon: state.canon, ledgers: state.ledgers });
  assert.deepEqual(beat.plantOrPay, ['sd_hot']);
});

test('character mode adds a constraint to protect the player’s agency', () => {
  const state = makeState();
  const beat = new Director().plan({
    canon: state.canon, ledgers: state.ledgers, mode: 'character', holderId: 'e2',
  });
  assert.ok(beat.constraintNotes.some(n => n.includes('谢云舒')));
});

test('planning is deterministic — two calls agree', () => {
  const state = makeState();
  const d = new Director();
  assert.deepEqual(
    d.plan({ canon: state.canon, ledgers: state.ledgers }),
    d.plan({ canon: state.canon, ledgers: state.ledgers })
  );
});

test('characters without goals are never asked to advance', () => {
  const state = makeState();
  for (const e of state.canon.entities) e.goal = '';
  const beat = new Director().plan({ canon: state.canon, ledgers: state.ledgers });
  assert.deepEqual(beat.mustAdvance, []);
});

test('dead characters are excluded from mustAdvance', () => {
  const state = makeState();
  const li = state.canon.entities.find(e => e.name === '李明远');
  li.alive = false;

  const beat = new Director().plan({ canon: state.canon, ledgers: state.ledgers });
  assert.ok(!beat.mustAdvance.includes(li.id));
});
