/**
 * P0 acceptance — state layer.
 *
 * Covers the two structural claims of v2: secrets are facts (not card strings),
 * and the turn is a transaction whose counters only move on commit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonFromGeneratedWorld, secretsOf, allSecrets, entityByName, currentChapter, resolveRef,
} from '../src/state/canon.js';
import {
  createMinds, mindFor, addKnowledge, stanceOn, adjustTrust, knowsFact,
} from '../src/state/mind.js';
import {
  createLedgers, addSeed, addEvent, paySeed, openSeeds, computeUrgency, seedsByUrgency, linkCausality,
} from '../src/state/ledger.js';
import { VersionStore } from '../src/state/version.js';
import { applyDelta } from '../src/state/commit.js';
import { FIXTURE_WORLD, makeState } from './helpers.js';

// ── Canon ────────────────────────────────────────────────────────────────────

test('world generation turns each character secret into a `secret` fact', () => {
  const canon = canonFromGeneratedWorld(FIXTURE_WORLD, 1);

  assert.equal(canon.entities.length, 3);
  assert.equal(canon.turn, 0);
  assert.equal(canon.version, 0);

  const secrets = allSecrets(canon);
  assert.equal(secrets.length, 3);
  for (const s of secrets) {
    assert.equal(s.predicate, 'secret');
    assert.deepEqual(s.tags, ['secret']);
    assert.equal(s.turn, 0);
    assert.equal(s.salience, 1);
  }

  // Secrets live on facts — the entity carries no `secret` field at all.
  for (const entity of canon.entities) {
    assert.ok(!('secret' in entity), 'entity must not carry a secret string');
  }
});

test('secretsOf answers per-holder, replacing the old character.secret field', () => {
  const canon = canonFromGeneratedWorld(FIXTURE_WORLD, 1);
  const li = entityByName(canon, '李明远');

  const secrets = secretsOf(canon, li.id);
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].object, '实为地下党联络员');

  const others = canon.entities.filter(e => e.id !== li.id);
  for (const other of others) {
    assert.equal(secretsOf(canon, other.id).length, 1);
  }
});

test('chapter state is initialized with the first chapter active', () => {
  const canon = canonFromGeneratedWorld(FIXTURE_WORLD, 1);
  assert.equal(canon.chapters.length, 2);
  assert.equal(currentChapter(canon).status, 'active');
  assert.equal(canon.chapters[1].status, 'locked');
  assert.equal(canon.chapterIndex, 0);
});

test('resolveRef maps names to ids and leaves unknown values verbatim', () => {
  const canon = canonFromGeneratedWorld(FIXTURE_WORLD, 1);
  assert.equal(resolveRef(canon, '李明远'), entityByName(canon, '李明远').id);
  assert.equal(resolveRef(canon, 'e1'), 'e1');
  assert.equal(resolveRef(canon, '某个不存在的人'), '某个不存在的人');
});

// ── Mind ─────────────────────────────────────────────────────────────────────

test('a holder knows its own secret and no one else’s', () => {
  const canon = canonFromGeneratedWorld(FIXTURE_WORLD, 1);
  const minds = createMinds(canon);

  assert.equal(minds.size, 3);

  for (const entity of canon.entities) {
    const mind = mindFor(minds, entity.id);
    const own = secretsOf(canon, entity.id);
    assert.equal(mind.knows.length, 1);
    assert.equal(mind.knows[0].factId, own[0].id);

    for (const other of canon.entities) {
      if (other.id === entity.id) continue;
      const otherSecret = secretsOf(canon, other.id)[0];
      assert.equal(stanceOn(mind, otherSecret.id), null, 'must not know another’s secret');
    }
  }
});

test('initial trust is deterministic, not random', () => {
  const canon = canonFromGeneratedWorld(FIXTURE_WORLD, 1);
  const a = createMinds(canon);
  const b = createMinds(canon);

  for (const [id, mind] of a) {
    assert.deepEqual(mind.trust, b.get(id).trust);
  }
  for (const edge of Object.values(mindFor(a, 'e1').trust)) {
    assert.ok(edge.value >= 30 && edge.value <= 70);
  }
});

test('addKnowledge keeps one stance per fact and is idempotent', () => {
  const canon = canonFromGeneratedWorld(FIXTURE_WORLD, 1);
  const minds = createMinds(canon);
  const mind = mindFor(minds, 'e2');
  const factId = secretsOf(canon, 'e1')[0].id;

  addKnowledge(mind, factId, 'suspects', 1);
  assert.equal(stanceOn(mind, factId), 'suspects');

  addKnowledge(mind, factId, 'suspects', 1);
  assert.equal(mind.suspects.filter(r => r.factId === factId).length, 1, 'no duplicate refs');

  // Upgrading a suspicion to knowledge must remove the suspicion.
  addKnowledge(mind, factId, 'knows', 2);
  assert.equal(stanceOn(mind, factId), 'knows');
  assert.equal(mind.suspects.length, 0);
  assert.ok(knowsFact(mind, factId));
});

test('adjustTrust clamps to [0, 100]', () => {
  const canon = canonFromGeneratedWorld(FIXTURE_WORLD, 1);
  const mind = mindFor(createMinds(canon), 'e1');

  adjustTrust(mind, 'e2', 999, 1);
  assert.equal(mind.trust.e2.value, 100);

  adjustTrust(mind, 'e2', -999, 2);
  assert.equal(mind.trust.e2.value, 0);
  assert.deepEqual(mind.trust.e2.evidence, [1, 2]);
});

// ── Ledger ───────────────────────────────────────────────────────────────────

test('seed urgency grows with age and spikes near a chapter end', () => {
  const seed = { plantedTurn: 0 };
  const young = computeUrgency(seed, { currentTurn: 1 });
  const old = computeUrgency(seed, { currentTurn: 10 });
  const overdue = computeUrgency(seed, { currentTurn: 10, nearChapterEnd: true });

  assert.ok(young < old, 'older seeds are more urgent');
  assert.ok(old < overdue, 'chapter end raises urgency');
  assert.ok(overdue <= 1 && young >= 0);
});

test('seedsByUrgency returns only open seeds, most urgent first', () => {
  const ledgers = createLedgers();
  const a = addSeed(ledgers, { id: 'sd_a', plantedTurn: 0, text: 'A' });
  const b = addSeed(ledgers, { id: 'sd_b', plantedTurn: 0, text: 'B' });
  const paid = addSeed(ledgers, { id: 'sd_c', plantedTurn: 0, text: 'C' });

  a.urgency = 0.2;
  b.urgency = 0.9;
  paid.urgency = 1;
  paySeed(ledgers, 'sd_c', 5);

  assert.deepEqual(seedsByUrgency(ledgers).map(s => s.id), ['sd_b', 'sd_a']);
  assert.equal(openSeeds(ledgers).length, 2);
});

test('paySeed is idempotent — a repeated payoff cannot corrupt the ledger', () => {
  const ledgers = createLedgers();
  addSeed(ledgers, { id: 'sd_x', plantedTurn: 0, text: 'X' });

  assert.equal(paySeed(ledgers, 'sd_x', 3, 'ev_1'), true);
  assert.equal(paySeed(ledgers, 'sd_x', 4, 'ev_2'), false, 'second payoff is a no-op');
  assert.equal(ledgers.seeds[0].payoffTurn, 3);
  assert.equal(ledgers.seeds[0].payoffEventId, 'ev_1');
});

test('causal links are recorded on both events', () => {
  const ledgers = createLedgers();
  addEvent(ledgers, { id: 'ev_1', turn: 1, kind: 'action', summary: '开火' });
  addEvent(ledgers, { id: 'ev_2', turn: 2, kind: 'action', summary: '复仇' });

  assert.equal(linkCausality(ledgers, 'ev_1', 'ev_2'), true);
  assert.deepEqual(ledgers.events[0].effects, ['ev_2']);
  assert.deepEqual(ledgers.events[1].causes, ['ev_1']);
  assert.equal(linkCausality(ledgers, 'ev_1', 'nope'), false);
});

// ── Versions ─────────────────────────────────────────────────────────────────

test('commit assigns a monotonic version and checkout restores it', () => {
  const canon = canonFromGeneratedWorld(FIXTURE_WORLD, 1);
  const store = new VersionStore(canon);

  assert.equal(store.head, 0);

  const next = { ...store.headCanon, turn: 1 };
  const v1 = store.commit(next);
  assert.ok(v1 > 0);
  assert.equal(store.head, v1);
  assert.equal(store.headCanon.version, v1, 'commit stamps the new version onto canon');

  const back = store.checkout(0);
  assert.equal(back.canon.turn, 0);
  assert.equal(store.head, 0);
});

test('a snapshot covers minds and ledgers, not just canon', () => {
  const canon = canonFromGeneratedWorld(FIXTURE_WORLD, 1);
  const minds = createMinds(canon);
  const ledgers = createLedgers();
  addSeed(ledgers, { id: 'sd_1', plantedTurn: 0, text: '信' });

  const store = new VersionStore({ canon, minds, ledgers, turnRecords: [] });
  const withKnowledge = createMinds(canon);
  const factId = secretsOf(canon, 'e1')[0].id;
  addKnowledge(mindFor(withKnowledge, 'e2'), factId, 'knows', 1);

  store.commit({ canon: { ...canon, turn: 1 }, minds: withKnowledge, ledgers, turnRecords: [{ turn: 1 }] });

  const restored = store.checkout(0);
  assert.equal(restored.canon.turn, 0);
  assert.equal(stanceOn(mindFor(restored.minds, 'e2'), factId), null,
    'the restored Mind must not remember a future reveal');
  assert.equal(restored.ledgers.seeds.length, 1, 'ledgers are snapshotted too');
});

test('branch never deletes the other world line’s versions', () => {
  const canon = canonFromGeneratedWorld(FIXTURE_WORLD, 1);
  const store = new VersionStore(canon);

  const v1 = store.commit({ ...store.headCanon, turn: 1 });
  const v2 = store.commit({ ...store.headCanon, turn: 2 });

  // Fork from v1 and commit a different future.
  // (`VersionStore.branch` takes a version number; `ELNRuntime.branch` takes `{ from }`.)
  const { version: branchPoint } = store.branch(v1);
  assert.equal(branchPoint, v1);

  const v3 = store.commit({ ...store.headCanon, turn: 99 });
  assert.ok(v3 > v2, 'versions stay globally unique across lines');

  // The original line is still reachable.
  const original = store.checkout(v2);
  assert.equal(original.canon.turn, 2);
  assert.equal(store.versions().length, 4);
});

// ── Commit ───────────────────────────────────────────────────────────────────

test('applyDelta advances turn and chapter counters inside the transaction', () => {
  const state = makeState();
  assert.equal(state.canon.turn, 0);
  assert.equal(currentChapter(state.canon).completedTurns, 0);

  const out = applyDelta({
    canon: state.canon,
    minds: state.minds,
    ledgers: state.ledgers,
    delta: { summary: '第一回合', world: { tension: 45 }, events: [{ kind: 'action', summary: '开场' }] },
  });

  assert.equal(out.canon.turn, 1);
  assert.equal(currentChapter(out.canon).completedTurns, 1);
  assert.equal(out.canon.tension, 45);
  assert.equal(out.ledgers.events.length, 1);
  assert.equal(out.ledgers.events[0].source, 'narrative');
  assert.equal(out.turnRecord.summary, '第一回合');
});

test('tension moves at most 20 points per turn', () => {
  const state = makeState();
  const out = applyDelta({
    canon: state.canon, minds: state.minds, ledgers: state.ledgers,
    delta: { world: { tension: 100 } },
  });
  assert.equal(out.canon.tension, 50, '30 + clamped step of 20');
});

test('applyDelta never mutates its input state', () => {
  const state = makeState();
  const turnBefore = state.canon.turn;
  const factsBefore = state.canon.facts.length;
  const trustBefore = structuredClone(mindFor(state.minds, 'e2').trust);

  applyDelta({
    canon: state.canon,
    minds: state.minds,
    ledgers: state.ledgers,
    delta: {
      characters: [{ name: '谢云舒', trust_changes: { 李明远: -20 }, emotion: '愤怒' }],
      facts: [{ subject: '谢云舒', predicate: 'distrusts', object: '李明远' }],
      events: [{ kind: 'action', summary: '翻脸' }],
    },
  });

  assert.equal(state.canon.turn, turnBefore, 'turn counter must not drift');
  assert.equal(state.canon.facts.length, factsBefore);
  assert.deepEqual(mindFor(state.minds, 'e2').trust, trustBefore);
  assert.equal(state.ledgers.events.length, 0);
});

test('a knowledge reference resolves to the fact committed in the same turn', () => {
  const state = makeState();
  const out = applyDelta({
    canon: state.canon,
    minds: state.minds,
    ledgers: state.ledgers,
    delta: {
      facts: [{ subject: '赵鹏', predicate: 'secret', object: '收受日谍贿赂', tags: ['secret'] }],
      knowledge: [{ holderId: '谢云舒', factIndex: 0, stance: 'suspects' }],
    },
  });

  const newFact = out.canon.facts.find(f => f.object === '收受日谍贿赂');
  assert.ok(newFact, 'fact committed');
  assert.equal(stanceOn(mindFor(out.minds, 'e2'), newFact.id), 'suspects');
});

test('a reported secret reveal writes knowledge onto the target’s Mind', () => {
  const state = makeState();
  const liSecret = secretsOf(state.canon, entityByName(state.canon, '李明远').id)[0];
  const xieMind = mindFor(state.minds, entityByName(state.canon, '谢云舒').id);

  assert.equal(stanceOn(xieMind, liSecret.id), null, 'starts unknown');

  const out = applyDelta({
    canon: state.canon,
    minds: state.minds,
    ledgers: state.ledgers,
    delta: { reveals_secret: [{ from: '李明远', to: '谢云舒', content: '实为地下党联络员' }] },
  });

  const target = mindFor(out.minds, entityByName(out.canon, '谢云舒').id);
  assert.equal(stanceOn(target, liSecret.id), 'knows');
  assert.equal(out.secretReveals.length, 1);
  assert.equal(out.secretReveals[0].content, '实为地下党联络员');
});
