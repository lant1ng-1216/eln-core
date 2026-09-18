/**
 * ELN Core — State / Mind
 *
 * A Mind is one subject's private view of the world (DESIGN §2.3). Crucially it
 * is **not a subset of Canon** — it is a mapping that may contain errors. A
 * holder can `believesFalse` something that never happened; that is where
 * misunderstanding, lies and dramatic irony come from.
 *
 * P0 keeps holder-level granularity but stores `FactRef` objects, so upgrading
 * to fact-level confidence and evidence chains needs no structural change.
 */

import { MindSchema, FactRefSchema } from '../contracts/schema.js';
import { validateMind } from '../contracts/validate.js';
import { hashString } from './canon.js';

/** Deterministic initial trust in [30, 70], stable across runs and branches. */
function initialTrust(holderId, targetId) {
  return 30 + (hashString(`${holderId}|${targetId}`) % 41);
}

/**
 * Create one Mind per character entity.
 *
 * A character starts out knowing its own secrets — and only its own.
 *
 * @param {import('../contracts/types.js').Canon} canon
 * @returns {Map<string, import('../contracts/types.js').Mind>}
 */
export function createMinds(canon) {
  const characters = canon.entities.filter(e => e.kind === 'character');
  const minds = new Map();

  for (const holder of characters) {
    const knows = canon.facts
      .filter(f => f.subject === holder.id && f.tags.includes('secret'))
      .map(f => ({ factId: f.id, confidence: 1, since: 0, evidence: [] }));

    const trust = {};
    for (const other of characters) {
      if (other.id === holder.id) continue;
      trust[other.id] = { value: initialTrust(holder.id, other.id), evidence: [] };
    }

    minds.set(holder.id, MindSchema.parse({ holderId: holder.id, knows, trust }));
  }

  return minds;
}

/** @returns {import('../contracts/types.js').Mind|undefined} */
export function mindFor(minds, holderId) {
  return minds.get(holderId);
}

/** Does `holderId` hold any stance on `factId`? @returns {boolean} */
export function knowsFact(mind, factId) {
  if (!mind) return false;
  return [...mind.knows, ...mind.suspects, ...mind.believesFalse]
    .some(ref => ref.factId === factId);
}

/** Stance of a holder on a fact, or `null` when unknown. */
export function stanceOn(mind, factId) {
  if (!mind) return null;
  if (mind.knows.some(r => r.factId === factId)) return 'knows';
  if (mind.suspects.some(r => r.factId === factId)) return 'suspects';
  if (mind.believesFalse.some(r => r.factId === factId)) return 'believesFalse';
  return null;
}

/**
 * Record that a holder holds a stance on a fact. Idempotent: re-adding the same
 * (holder, fact) updates the existing ref instead of duplicating it. A holder
 * keeps exactly one stance per fact, so recording `knows` clears a previous
 * `suspects`.
 *
 * @param {import('../contracts/types.js').Mind} mind
 * @param {string} factId
 * @param {'knows'|'suspects'|'believesFalse'} stance
 * @param {number} turn
 * @param {number[]} [evidence]
 */
export function addKnowledge(mind, factId, stance, turn, evidence = []) {
  const lists = { knows: mind.knows, suspects: mind.suspects, believesFalse: mind.believesFalse };
  for (const list of Object.values(lists)) {
    const i = list.findIndex(r => r.factId === factId);
    if (i >= 0) list.splice(i, 1);
  }
  const ref = FactRefSchema.parse({ factId, confidence: 1, since: turn, evidence });
  lists[stance].push(ref);
}

/** Set absolute trust, clamped to [0, 100]. */
export function setTrust(mind, targetId, value, turn) {
  const prev = mind.trust[targetId] ?? { value: 30, evidence: [] };
  mind.trust[targetId] = {
    value: Math.max(0, Math.min(100, value)),
    evidence: turn === undefined ? prev.evidence : [...prev.evidence, turn],
  };
}

/** Shift trust by `delta`, clamped to [0, 100]. */
export function adjustTrust(mind, targetId, delta, turn) {
  const prev = mind.trust[targetId]?.value ?? 30;
  setTrust(mind, targetId, prev + delta, turn);
}

/** Character entity ids that have a Mind. */
export function holderIds(minds) {
  return [...minds.keys()];
}

export function cloneMinds(minds) {
  return new Map([...minds].map(([k, v]) => [k, structuredClone(v)]));
}

export function assertMind(mind) {
  return validateMind(mind);
}
