/**
 * ELN Core — State / Commit
 *
 * The single write path into world state (DESIGN §5.1 step 6).
 *
 * `applyDelta` is pure: it clones canon/minds/ledgers, applies a validated
 * extraction payload, and returns the next state. Because nothing is mutated in
 * place, a failure anywhere in the turn leaves the previous state untouched —
 * the property 0.1.0 lacked, where `turn` and `completedTurns` were incremented
 * before the call that could fail.
 *
 * Turn counters advance *here*, inside the transaction, so they can never drift
 * ahead of committed state.
 */

import { cloneCanon, makeIdFactory, resolveRef, secretsOf } from './canon.js';
import { cloneMinds, mindFor, addKnowledge, adjustTrust } from './mind.js';
import { cloneLedgers, addEvent, addSeed, paySeed, seedById, recomputeUrgency } from './ledger.js';
import { BeatSchema } from '../contracts/schema.js';

/** Clamp `v` into [lo, hi]. */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Maximum tension movement per turn, so the actual value cannot teleport. */
const TENSION_MAX_STEP = 20;

/**
 * @typedef {Object} CommitInput
 * @property {import('../contracts/types.js').Canon} canon
 * @property {Map<string, import('../contracts/types.js').Mind>} minds
 * @property {{events: Array, seeds: Array}} ledgers
 * @property {object} delta      - Result of `validateExtraction().blocks`
 * @property {string} [narrative]
 * @property {string[]} [degraded]
 * @property {boolean} [nearChapterEnd]      - Feeds the seed urgency deadline term
 * @property {(seed: object) => number} [mentionsOf] - How often a seed resurfaced
 */

/**
 * @typedef {Object} CommitResult
 * @property {import('../contracts/types.js').Canon} canon
 * @property {Map<string, import('../contracts/types.js').Mind>} minds
 * @property {{events: Array, seeds: Array}} ledgers
 * @property {object} turnRecord
 * @property {Array} secretReveals
 * @property {object|null} editor
 * @property {string[]} degraded
 */

/**
 * Apply a validated delta and produce the next committed state.
 *
 * @param {CommitInput} input
 * @returns {CommitResult}
 */
export function applyDelta({
  canon: prevCanon,
  minds: prevMinds,
  ledgers: prevLedgers,
  delta = {},
  narrative = '',
  degraded = [],
  nearChapterEnd = false,
  mentionsOf = null,
}) {
  const canon = cloneCanon(prevCanon);
  const minds = cloneMinds(prevMinds);
  const ledgers = cloneLedgers(prevLedgers);

  // ── Turn counter advances inside the transaction ──
  canon.turn = prevCanon.turn + 1;
  const turn = canon.turn;
  const chapter = canon.chapters[canon.chapterIndex];
  if (chapter) chapter.completedTurns += 1;

  const idf = makeIdFactory(turn);
  const secretReveals = [];

  // ── World block: observed values (DESIGN §10.3 — actual, not intent) ──
  const world = delta.world;
  if (world) {
    if (world.location) canon.location = world.location;
    if (world.time) canon.time = world.time;
    if (typeof world.tension === 'number') {
      const step = clamp(world.tension - canon.tension, -TENSION_MAX_STEP, TENSION_MAX_STEP);
      canon.tension = clamp(canon.tension + step, 0, 100);
    }
  }

  // ── Character block ──
  for (const upd of delta.characters ?? []) {
    const id = resolveRef(canon, upd.name);
    const entity = canon.entities.find(e => e.id === id && e.kind === 'character');
    if (!entity) continue;
    if (upd.emotion) entity.emotion = upd.emotion;
    if (upd.goal) entity.goal = upd.goal;
    if (upd.alive === false) entity.alive = false;
    if (upd.alive === true) entity.alive = true;

    if (upd.trust_changes) {
      const holder = mindFor(minds, entity.id);
      if (holder) {
        for (const [targetName, deltaValue] of Object.entries(upd.trust_changes)) {
          const targetId = resolveRef(canon, targetName);
          if (targetId === entity.id) continue;
          adjustTrust(holder, targetId, deltaValue, turn);
        }
      }
    }
  }

  // ── Facts block — ids assigned here, subject/object resolved to entity ids ──
  /** @type {string[]} maps extraction `factIndex` → committed fact id */
  const factIds = [];
  for (const f of delta.facts ?? []) {
    const fact = {
      id: idf('f'),
      subject: resolveRef(canon, f.subject),
      predicate: f.predicate,
      predicate_raw: f.predicate_raw ?? f.predicate,
      object: resolveRef(canon, f.object),
      turn,
      salience: f.salience ?? 0.5,
      tags: f.tags ?? [],
      evidence: { turn, quote: f.evidence ?? '' },
    };
    canon.facts.push(fact);
    factIds.push(fact.id);
  }

  // ── Event block ──
  // `source` records provenance: extracted events are 'narrative', while a
  // god-mode intervention or player action is injected with its own source.
  for (const e of delta.events ?? []) {
    addEvent(ledgers, {
      id: idf('ev'),
      turn,
      kind: e.kind,
      actors: (e.actors ?? []).map(a => resolveRef(canon, a)),
      location: e.location ?? canon.location,
      time: e.time ?? canon.time,
      summary: e.summary,
      source: e.source ?? 'narrative',
    });
  }

  // ── Seed block ──
  for (const s of delta.seeds ?? []) {
    addSeed(ledgers, {
      id: idf('sd'),
      plantedTurn: turn,
      text: s.text,
      kind: s.kind,
      holderIds: (s.holderIds ?? []).map(h => resolveRef(canon, h)),
      status: 'open',
      urgency: 0,
    });
  }

  // ── Seed payoffs ──
  for (const p of delta.seed_payoffs ?? []) {
    paySeed(ledgers, p.seedId, turn);
  }

  // ── Knowledge block: model-declared stances on newly extracted facts ──
  for (const k of delta.knowledge ?? []) {
    const holderId = resolveRef(canon, k.holderId);
    const mind = mindFor(minds, holderId);
    const factId = factIds[k.factIndex];
    if (!mind || !factId) continue;
    addKnowledge(mind, factId, k.stance, turn, [turn]);
  }

  // ── Secret reveals: a state write, not a prompt patch (DESIGN §2.3) ──
  for (const rv of delta.reveals_secret ?? []) {
    const fromId = resolveRef(canon, rv.from);
    const toId = resolveRef(canon, rv.to);
    const toMind = mindFor(minds, toId);
    if (!toMind) continue;
    const secrets = secretsOf(canon, fromId);
    for (const secret of secrets) {
      addKnowledge(toMind, secret.id, 'knows', turn, [turn]);
      secretReveals.push({ from: fromId, to: toId, factId: secret.id, content: secret.object });
    }
  }

  // ── Chapter beat ──
  if (chapter) {
    chapter.beats.push(BeatSchema.parse({ turn, done: true }));
  }

  // ── Seed urgency ──
  // Deterministic: age + how often the thread resurfaced + whether the chapter
  // is closing. `mentionsOf` comes from the memory layer; without it a seed
  // ages but never gains a mention bonus.
  recomputeUrgency(ledgers, { currentTurn: turn, nearChapterEnd, mentionsOf: mentionsOf ?? undefined });

  const turnRecord = {
    turn,
    chapter: canon.chapterIndex,
    tension: canon.tension,
    summary: delta.summary ?? '',
    degraded,
  };

  return {
    canon,
    minds,
    ledgers,
    turnRecord,
    secretReveals,
    editor: delta.editor ?? null,
    degraded,
  };
}

/**
 * Force a secret reveal outside the extraction flow (the god-mode control).
 * Returns the mutated mind and the secrets now known, or `null` if the holder
 * or target is unknown.
 *
 * @param {import('../contracts/types.js').Canon} canon
 * @param {Map<string, import('../contracts/types.js').Mind>} minds
 * @param {string} fromName
 * @param {string} toName
 * @param {number} turn
 */
export function forceReveal(canon, minds, fromName, toName, turn) {
  const fromId = resolveRef(canon, fromName);
  const toId = resolveRef(canon, toName);
  const toMind = mindFor(minds, toId);
  if (!toMind) return null;
  const secrets = secretsOf(canon, fromId);
  if (!secrets.length) return { revealed: [], toId };
  for (const secret of secrets) addKnowledge(toMind, secret.id, 'knows', turn, [turn]);
  return { revealed: secrets, toId };
}
