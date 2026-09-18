/**
 * ELN Core — Expression / Constraint packs
 *
 * Hard formatting constraints (DESIGN §6). These are declarative so that a user
 * can tighten or relax them without touching prompt-building code. `compose()`
 * renders them using the active style pack's dialogue/monologue labels.
 */

/**
 * @typedef {Object} ConstraintPack
 * @property {'constraint'} kind
 * @property {string} key
 * @property {number} minWords
 * @property {boolean} forbidSeparators  - Bans asterisk/dash scene dividers
 * @property {boolean} dialoguePerLine   - One dialogue line per line, nothing else on it
 * @property {boolean} monologueInline   - Emit inner monologue as its own line
 * @property {boolean} requireHook       - End on a hook
 * @property {boolean} reportSecret      - Ask for a 【秘密透露】 trailer line
 * @property {boolean} reportSummary     - Ask for a 【摘要】 trailer line
 * @property {string[]} extra             - Additional free-form rules
 */

/** @type {Record<string, ConstraintPack>} */
export const CONSTRAINT_PACKS = {
  default: {
    kind: 'constraint',
    key: 'default',
    minWords: 900,
    forbidSeparators: true,
    dialoguePerLine: true,
    monologueInline: true,
    requireHook: true,
    reportSecret: true,
    reportSummary: true,
    extra: [],
  },

  /** Tighter budget for cheap models or short-form play. */
  compact: {
    kind: 'constraint',
    key: 'compact',
    minWords: 400,
    forbidSeparators: true,
    dialoguePerLine: true,
    monologueInline: false,
    requireHook: true,
    reportSecret: true,
    reportSummary: true,
    extra: [],
  },
};

/** Wrap a constraint key (or a raw pack object) into a pack. */
export function constraintPack(keyOrPack) {
  if (keyOrPack && typeof keyOrPack === 'object' && keyOrPack.kind === 'constraint') return keyOrPack;
  const pack = CONSTRAINT_PACKS[keyOrPack];
  if (!pack) {
    throw new Error(
      `[ELN] Unknown constraint pack "${keyOrPack}". Available: ${Object.keys(CONSTRAINT_PACKS).join(', ')}`
    );
  }
  return pack;
}

export const CONSTRAINT_KEYS = Object.freeze(Object.keys(CONSTRAINT_PACKS));
