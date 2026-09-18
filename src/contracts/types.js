/**
 * ELN Core — Contracts / Types
 *
 * JSDoc typedefs mirroring `schema.js`. These are the source of truth for
 * editor tooling and for the generated `index.d.ts`; the zod schemas in
 * `schema.js` are the runtime authority. Keep the two in sync.
 */

/**
 * @typedef {'character'|'place'|'item'} EntityKind
 * @typedef {'action'|'dialogue'|'reveal'|'intervention'|'offscreen'|'world'} EventKind
 * @typedef {'narrative'|'player'|'director'|'agent'} EventSource
 * @typedef {'item'|'promise'|'identity'|'prophecy'|'question'} SeedKind
 * @typedef {'open'|'paid'|'abandoned'} SeedStatus
 * @typedef {'knows'|'suspects'|'believesFalse'} Stance
 * @typedef {'active'|'locked'|'done'} ChapterStatus
 * @typedef {'director'|'character'} Mode
 */

/**
 * @typedef {Object} Entity
 * @property {string} id
 * @property {EntityKind} kind
 * @property {string} name
 * @property {string} role
 * @property {string} personality
 * @property {string} goal
 * @property {boolean} alive
 * @property {string} emotion
 * @property {string} [weightTag]
 * @property {string} [trigger]
 * @property {string[]} tags
 */

/**
 * @typedef {Object} Fact
 * @property {string} id
 * @property {string} subject  - EntityId when resolvable, else the raw name
 * @property {string} predicate - Controlled predicate key
 * @property {string} predicate_raw
 * @property {string} object
 * @property {number} turn
 * @property {number} salience
 * @property {string[]} tags
 */

/**
 * @typedef {Object} Beat
 * @property {number} turn
 * @property {string} intent
 * @property {number} [tensionTarget]
 * @property {boolean} done
 */

/**
 * @typedef {Object} ChapterState
 * @property {number} index
 * @property {string} name
 * @property {string} goal
 * @property {number} targetTurns
 * @property {number} completedTurns
 * @property {ChapterStatus} status
 * @property {Beat[]} beats
 * @property {{seedsToPay: string[], goalsToMeet: string[]}} closeCriteria
 */

/**
 * @typedef {Object} Canon
 * @property {string} id
 * @property {number} version
 * @property {{name: string, tag: string, background: string, outline: string, createdAt: number}} meta
 * @property {string} time
 * @property {string} location
 * @property {number} tension
 * @property {Entity[]} entities
 * @property {Fact[]} facts
 * @property {ChapterState[]} chapters
 * @property {number} chapterIndex
 * @property {number} turn
 */

/**
 * @typedef {Object} FactRef
 * @property {string} factId
 * @property {number} [confidence]
 * @property {number} [since]
 * @property {number[]} [evidence]
 */

/**
 * @typedef {Object} TrustEdge
 * @property {number} value
 * @property {number[]} evidence
 */

/**
 * @typedef {Object} Mind
 * @property {string} holderId
 * @property {FactRef[]} knows
 * @property {FactRef[]} suspects
 * @property {FactRef[]} believesFalse
 * @property {Object<string, TrustEdge>} trust
 */

/**
 * @typedef {Object} Event
 * @property {string} id
 * @property {number} turn
 * @property {EventKind} kind
 * @property {string[]} actors
 * @property {string} location
 * @property {string} time
 * @property {string} summary
 * @property {string[]} causes
 * @property {string[]} effects
 * @property {EventSource} source
 */

/**
 * @typedef {Object} Seed
 * @property {string} id
 * @property {number} plantedTurn
 * @property {string} text
 * @property {SeedKind} kind
 * @property {string[]} holderIds
 * @property {SeedStatus} status
 * @property {number} [payoffTurn]
 * @property {string} [payoffEventId]
 * @property {number} urgency
 */

/**
 * @typedef {Object} View
 * @property {Mode} mode
 * @property {string} [holderId]
 * @property {Canon} canon
 * @property {Mind} [mind]
 * @property {Fact[]} visibleFacts
 * @property {Fact[]} hiddenSecrets
 */

/**
 * @typedef {Object} BeatSpec
 * @property {string[]} mustAdvance
 * @property {string[]} mustComplicate
 * @property {string[]} plantOrPay
 * @property {number} tensionTarget
 * @property {string} hookKind
 * @property {string[]} constraintNotes
 */

export {};
