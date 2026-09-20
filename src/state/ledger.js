/**
 * ELN Core — State / Ledgers
 *
 * Two append-only books (DESIGN §2.4, §2.5):
 *
 *  - **Event ledger** — what actually happened, with causal links. `source`
 *    already reserves the `'agent'` channel for P5 off-screen character action.
 *  - **Seed ledger** — planted foreshadowing and whether it has been paid off.
 *
 * `urgency` is computed by deterministic rules, never asked of the LLM. That is
 * what makes a long story feel authored: the engine remembers.
 */

import { EventSchema, SeedSchema } from '../contracts/schema.js';
import { validateEvent } from '../contracts/validate.js';

/** @returns {{events: import('../contracts/types.js').Event[], seeds: import('../contracts/types.js').Seed[]}} */
export function createLedgers() {
  return { events: [], seeds: [] };
}

export function cloneLedgers(ledgers) {
  return {
    events: structuredClone(ledgers.events),
    seeds: structuredClone(ledgers.seeds),
  };
}

// ── Events ───────────────────────────────────────────────────────────────────

export function addEvent(ledgers, event) {
  const parsed = EventSchema.parse(event);
  ledgers.events.push(parsed);
  return parsed;
}

export function eventById(ledgers, id) {
  return ledgers.events.find(e => e.id === id);
}

/** Events that happened on `turn`. */
export function eventsOnTurn(ledgers, turn) {
  return ledgers.events.filter(e => e.turn === turn);
}

/** Link `cause` → `effect` in the causal graph (idempotent). */
export function linkCausality(ledgers, causeId, effectId) {
  const cause = eventById(ledgers, causeId);
  const effect = eventById(ledgers, effectId);
  if (!cause || !effect) return false;
  if (!cause.effects.includes(effectId)) cause.effects.push(effectId);
  if (!effect.causes.includes(causeId)) effect.causes.push(causeId);
  return true;
}

// ── Seeds ────────────────────────────────────────────────────────────────────

export function addSeed(ledgers, seed) {
  const parsed = SeedSchema.parse(seed);
  ledgers.seeds.push(parsed);
  return parsed;
}

export function seedById(ledgers, id) {
  return ledgers.seeds.find(s => s.id === id);
}

export function openSeeds(ledgers) {
  return ledgers.seeds.filter(s => s.status === 'open');
}

/**
 * Mark a seed paid. A seed can only be paid once; repeat calls are no-ops so a
 * model that re-reports the same payoff does not corrupt the ledger.
 */
export function paySeed(ledgers, seedId, turn, eventId) {
  const seed = seedById(ledgers, seedId);
  if (!seed || seed.status !== 'open') return false;
  seed.status = 'paid';
  seed.payoffTurn = turn;
  if (eventId) seed.payoffEventId = eventId;
  return true;
}

export function abandonSeed(ledgers, seedId) {
  const seed = seedById(ledgers, seedId);
  if (!seed || seed.status !== 'open') return false;
  seed.status = 'abandoned';
  return true;
}

/**
 * Threads left open this long are given up on.
 *
 * Not every planted thread gets paid. Without a sweep, a forgotten one stays
 * `open` forever: it keeps appearing in the director's ledger, and it silently
 * blocks any chapter that waits for its threads to resolve. Abandoning it is the
 * honest record — the author moved on.
 */
export const ABANDON_AGE = 30;

/**
 * Abandon threads that have outlived any plausible payoff window.
 * Deterministic; called from the commit path so it is part of the transaction.
 *
 * @returns {string[]} ids of newly abandoned seeds
 */
export function sweepStaleSeeds(ledgers, { currentTurn, maxAge = ABANDON_AGE } = {}) {
  const abandoned = [];
  for (const seed of ledgers.seeds) {
    if (seed.status !== 'open') continue;
    if (currentTurn - seed.plantedTurn < maxAge) continue;
    seed.status = 'abandoned';
    abandoned.push(seed.id);
  }
  return abandoned;
}

/**
 * Deterministic urgency in [0, 1].
 *
 * A seed gets urgent as it ages, as it keeps being mentioned, and as the
 * chapter nears its turn budget. The weights are deliberate: age dominates
 * (a forgotten thread is the worst failure), mentions nudge, chapter-end
 * creates a deadline.
 *
 * @param {import('../contracts/types.js').Seed} seed
 * @param {{currentTurn: number, mentions?: number, nearChapterEnd?: boolean}} ctx
 */
export function computeUrgency(seed, ctx) {
  const age = Math.max(0, ctx.currentTurn - seed.plantedTurn);
  const ageTerm = Math.min(1, age / 10) * 0.5;
  const mentionTerm = Math.min(1, (ctx.mentions ?? 0) / 3) * 0.2;
  const endTerm = ctx.nearChapterEnd ? 0.3 : 0;
  return Math.max(0, Math.min(1, ageTerm + mentionTerm + endTerm));
}

/**
 * Recompute urgency for every open seed. `mentionsOf` lets the caller inject a
 * mention count (the memory layer supplies real counts in P2; P0 leaves it 0).
 */
export function recomputeUrgency(ledgers, { currentTurn, nearChapterEnd = false, mentionsOf }) {
  for (const seed of ledgers.seeds) {
    if (seed.status !== 'open') continue;
    seed.urgency = computeUrgency(seed, {
      currentTurn,
      nearChapterEnd,
      mentions: mentionsOf ? mentionsOf(seed) : 0,
    });
  }
  return ledgers.seeds;
}

/** Open seeds, most urgent first. */
export function seedsByUrgency(ledgers) {
  return openSeeds(ledgers).sort((a, b) => b.urgency - a.urgency);
}

export function assertEvent(event) {
  return validateEvent(event);
}
