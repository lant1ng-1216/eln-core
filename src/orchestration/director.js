/**
 * ELN Core — Orchestration / Director
 *
 * Answers "what must this turn accomplish?" (DESIGN §4). 0.1.0 handed the model
 * style instructions ("at least 900 words", "end on a hook"); the director hands
 * it *dramatic* ones ("advance A's goal, pay off the letter planted in turn 7,
 * close on a reversal").
 *
 * Everything that can be computed deterministically — the tension curve, seed
 * due dates, the chapter turn budget — is computed here and never asked of the
 * LLM. Only semantics needing understanding (`mustComplicate`) will call a cheap
 * model, and that lands in P2. P0 ships a working deterministic planner so the
 * turn transaction has a real `BeatSpec` to carry.
 */

import { seedsByUrgency } from '../state/ledger.js';
import { currentChapter } from '../state/canon.js';

/** Public headline for the turn's closing beat. */
export const HOOK_KINDS = Object.freeze(['悬念', '信息', '情感', '反转']);

/** Protagonists are asked to advance more often than supporting cast. */
const WEIGHT_PRIORITY = {
  '男主': 0, '女主': 0, '男二': 1, '女二': 1, '反派': 2, '男配': 3, '女配': 3, '隐藏角色': 4,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @typedef {Object} BeatSpec
 * @property {string[]} mustAdvance     - Entity ids whose goals must move
 * @property {string[]} mustComplicate  - Obstacles that must be introduced
 * @property {string[]} plantOrPay      - Seed ids to plant or pay off
 * @property {number} tensionTarget     - Intent value for this turn
 * @property {string} hookKind
 * @property {string[]} constraintNotes
 */

/**
 * The tension the chapter is aiming for at its current progress,
 * before error correction.
 */
function curveTarget(chapter) {
  if (!chapter) return 40;
  const progress = chapter.targetTurns > 0
    ? Math.min(1, chapter.completedTurns / chapter.targetTurns)
    : 0;
  return 25 + progress * 45; // rises 25 → 70 across the chapter
}

/**
 * Error-corrected target (decision §10.3, "差驱动").
 *
 * Canon's tension is the *observed* value; this is the *intent*. When the prose
 * has been running colder than the curve, the target is pushed up (and vice
 * versa), so the actual value converges on the curve instead of the curve
 * drifting away from the story.
 */
export function tensionTargetFor(canon, chapter) {
  const curve = curveTarget(chapter);
  const error = curve - canon.tension;
  return Math.round(clamp(curve + clamp(error * 0.5, -15, 15), 5, 95));
}

/**
 * Deterministically choose which characters must advance this turn.
 *
 * Selection is tiered by narrative weight, and the rotation happens *within* a
 * tier rather than across the whole cast. Rotating globally would let a minor
 * character outrank a protagonist on some turns, which defeats the point of
 * having a weight tag at all.
 */
function pickMustAdvance(canon, turn, limit = 2) {
  const candidates = canon.entities
    .filter(e => e.kind === 'character' && e.alive && e.goal)
    .sort((a, b) => {
      const pa = WEIGHT_PRIORITY[a.weightTag] ?? 3;
      const pb = WEIGHT_PRIORITY[b.weightTag] ?? 3;
      return pa - pb || a.id.localeCompare(b.id);
    });

  if (!candidates.length) return [];

  const tiers = new Map();
  for (const c of candidates) {
    const p = WEIGHT_PRIORITY[c.weightTag] ?? 3;
    if (!tiers.has(p)) tiers.set(p, []);
    tiers.get(p).push(c);
  }

  const ordered = [];
  for (const priority of [...tiers.keys()].sort((a, b) => a - b)) {
    const tier = tiers.get(priority);
    const offset = turn % tier.length;
    ordered.push(...tier.slice(offset), ...tier.slice(0, offset));
  }

  return ordered.slice(0, limit).map(c => c.id);
}

export class Director {
  /**
   * @param {object} [options]
   * @param {number} [options.maxSeedsPerTurn] - Seeds planted/paid per turn
   */
  constructor({ maxSeedsPerTurn = 2 } = {}) {
    this.maxSeedsPerTurn = maxSeedsPerTurn;
  }

  /**
   * Plan one beat.
   *
   * @param {Object} input
   * @param {import('../contracts/types.js').Canon} input.canon
   * @param {{events: Array, seeds: Array}} [input.ledgers]
   * @param {'director'|'character'} [input.mode]
   * @param {string} [input.holderId]
   * @returns {BeatSpec}
   */
  plan({ canon, ledgers = { events: [], seeds: [] }, mode = 'director', holderId = null }) {
    const chapter = currentChapter(canon);
    const turn = canon.turn + 1; // the turn about to be written

    const dueSeeds = seedsByUrgency(ledgers)
      .filter(s => s.urgency > 0)
      .slice(0, this.maxSeedsPerTurn)
      .map(s => s.id);

    const constraintNotes = [];
    if (mode === 'character' && holderId) {
      const holder = canon.entities.find(e => e.id === holderId);
      if (holder) constraintNotes.push(`必须给 ${holder.name} 留出行动与反应的余地`);
    }

    return {
      mustAdvance: pickMustAdvance(canon, turn),
      mustComplicate: [],
      plantOrPay: dueSeeds,
      tensionTarget: tensionTargetFor(canon, chapter),
      hookKind: HOOK_KINDS[turn % HOOK_KINDS.length],
      constraintNotes,
    };
  }
}

export function createDirector(options) {
  return new Director(options);
}

export function planBeat(director, input) {
  return (director ?? new Director()).plan(input);
}
