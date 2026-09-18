/**
 * ELN Core — Mind / Projection
 *
 * The single place where "director mode" and "character mode" differ
 * (DESIGN §3). Both are the *same* function with a different `holderId` —
 * switching perspective is a projection, not a branch in the logic.
 *
 * Director mode sees the whole Canon. Character mode sees only what that
 * holder knows, suspects or (wrongly) believes. Facts the holder has no stance
 * on are reported as *hidden* — by id and tag only, never by content — so the
 * renderers can emit a placeholder instead of silently shrinking the world.
 */

import { stanceOn } from '../state/mind.js';

/**
 * @typedef {Object} View
 * @property {'director'|'character'} mode
 * @property {string|null} holderId
 * @property {import('../contracts/types.js').Canon} canon
 * @property {import('../contracts/types.js').Mind|null} mind
 * @property {import('../contracts/types.js').Fact[]} visibleFacts
 * @property {import('../contracts/types.js').Fact[]} knownFacts
 * @property {import('../contracts/types.js').Fact[]} suspectedFacts
 * @property {import('../contracts/types.js').Fact[]} believedFacts
 * @property {Array<{id: string, tags: string[]}>} hiddenFacts - content withheld
 * @property {import('../contracts/types.js').Entity} holder
 */

/**
 * Project Canon through a holder's Mind.
 *
 * @param {import('../contracts/types.js').Canon} canon
 * @param {import('../contracts/types.js').Mind|null} mind
 * @param {'director'|'character'} mode
 * @param {string} [holderId]
 * @returns {View}
 */
export function projectCanon(canon, mind, mode = 'director', holderId) {
  if (mode === 'director') {
    return {
      mode,
      holderId: null,
      canon,
      mind: null,
      visibleFacts: canon.facts,
      knownFacts: canon.facts,
      suspectedFacts: [],
      believedFacts: [],
      hiddenFacts: [],
      holder: null,
    };
  }

  if (mode !== 'character') {
    throw new Error(`[ELN] Unknown mode "${mode}" (expected 'director' or 'character')`);
  }

  const holder = canon.entities.find(e => e.id === holderId);
  if (!holder) throw new Error(`[ELN] Unknown holder "${holderId}"`);
  if (!mind) throw new Error(`[ELN] Character mode requires a Mind for "${holderId}"`);

  const knownFacts = [];
  const suspectedFacts = [];
  const believedFacts = [];
  const hiddenFacts = [];

  for (const fact of canon.facts) {
    switch (stanceOn(mind, fact.id)) {
      case 'knows':         knownFacts.push(fact); break;
      case 'suspects':      suspectedFacts.push(fact); break;
      case 'believesFalse': believedFacts.push(fact); break;
      default:
        // No stance: withhold. Only identity and tags leave this layer.
        hiddenFacts.push({ id: fact.id, tags: fact.tags });
    }
  }

  return {
    mode,
    holderId,
    canon,
    mind,
    visibleFacts: [...knownFacts, ...suspectedFacts, ...believedFacts],
    knownFacts,
    suspectedFacts,
    believedFacts,
    hiddenFacts,
    holder,
  };
}

/**
 * Facts that are `secret` and hidden from this view.
 * Content is deliberately not included — callers get ids only.
 */
export function hiddenSecrets(view) {
  return view.hiddenFacts.filter(f => f.tags.includes('secret'));
}

/** True when `view` may see the content of `fact`. */
export function canSee(view, fact) {
  if (view.mode === 'director') return true;
  return view.visibleFacts.some(f => f.id === fact.id);
}
