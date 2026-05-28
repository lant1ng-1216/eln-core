/**
 * ELN Core — Type Definitions
 * All data structures used across the runtime.
 */

/**
 * @typedef {Object} Character
 * @property {string}  name
 * @property {string}  role
 * @property {string}  personality
 * @property {string}  secret
 * @property {string}  goal
 * @property {string}  [weightTag]
 * @property {string}  [trigger]
 * @property {boolean} alive
 * @property {string}  emotion
 * @property {Object.<string, number>} trustWith
 */

/**
 * @typedef {Object} Chapter
 * @property {number} id
 * @property {string} name
 * @property {string} goal
 * @property {number} targetTurns
 * @property {number} completedTurns
 * @property {'active'|'locked'|'done'} status
 * @property {Array}  beats
 */

/**
 * @typedef {Object} WorldState
 * @property {string} id
 * @property {string} name
 * @property {string} background
 * @property {string} outline
 * @property {number} turn
 * @property {number} currentChapter
 * @property {string} time
 * @property {string} location
 * @property {number} tension
 * @property {string} [_nextChapterHint]
 */

/**
 * @typedef {Object} TurnRecord
 * @property {number} turn
 * @property {number} chapter
 * @property {number} tension
 * @property {string} summary
 */

/**
 * @typedef {Object} Snapshot
 * @property {number}      turn
 * @property {WorldState}  worldState
 * @property {Character[]} characters
 * @property {Chapter[]}   chapters
 * @property {TurnRecord[]} turns
 */

/**
 * @typedef {Object} ELNRuntimeOptions
 * @property {string}   apiKey
 * @property {string}   [model]
 * @property {string}   [apiBase]
 * @property {Function} [onToken]
 * @property {Function} [onLine]
 * @property {Function} [onTurnEnd]
 */

export {};
