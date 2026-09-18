/**
 * ELN Core — Memory / Retriever
 *
 * Retrieval is an adapter (DESIGN §2.6). The engine only requires the
 * `search` method below; bring a vector retriever by implementing it.
 *
 * @typedef {Object} Retriever
 * @property {(records: import('./prose.js').ProseRecord[]) => void} index
 * @property {(query: string, opts: {limit?: number, entityIds?: string[], excludeTurns?: number[], minScore?: number}) => Array<{record: ProseRecord, score: number}>} search
 */

import { tokenize, scoreRecord } from './keywords.js';

/**
 * Default retriever: keyword + entity overlap over an in-memory record list.
 * Zero external services, deterministic, and good enough to resurface a detail
 * planted fifteen turns ago when its actors and nouns come up again.
 *
 * @implements {Retriever}
 */
export class KeywordRetriever {
  /**
   * @param {object} [options]
   * @param {import('./prose.js').ProseStore} [options.store] - Live store to read
   * @param {number} [options.limit]  - Default result count
   * @param {number} [options.minScore]
   */
  constructor({ store = null, limit = 3, minScore = 0.15 } = {}) {
    this._store = store;
    this._indexed = [];
    this.limit = limit;
    this.minScore = minScore;
  }

  /** Attach (or replace) the prose store this retriever reads from. */
  attach(store) {
    this._store = store;
    this._indexed = [];
    return this;
  }

  /**
   * Provide records explicitly. When the retriever has a store, omitting the
   * argument re-reads it — so callers never have to keep an index in sync.
   */
  index(records) {
    this._indexed = records
      ? [...records]
      : this._store ? this._store.all() : [];
    return this;
  }

  /** @returns {Array<{record: import('./prose.js').ProseRecord, score: number}>} */
  search(query, { limit, entityIds = [], excludeTurns = [], minScore } = {}) {
    const records = this._indexed.length
      ? this._indexed
      : this._store ? this._store.all() : [];

    const exclude = new Set(excludeTurns);
    const queryTokens = new Set(tokenize(query));
    const threshold = minScore ?? this.minScore;

    return records
      .filter(r => !exclude.has(r.turn))
      .map(record => ({ record, score: scoreRecord(record, queryTokens, { entityIds }) }))
      .filter(hit => hit.score >= threshold && hit.score > 0)
      .sort((a, b) => b.score - a.score || b.record.turn - a.record.turn)
      .slice(0, limit ?? this.limit);
  }

  /**
   * Search and shape the result for prompt assembly.
   * @returns {Array<{turn: number, text: string, score: number}>}
   */
  retrieve(query, options = {}) {
    const maxChars = options.maxChars ?? 300;
    return this.search(query, options).map(({ record, score }) => ({
      turn: record.turn,
      text: record.text.length > maxChars ? `${record.text.slice(0, maxChars)}…` : record.text,
      score: Number(score.toFixed(3)),
    }));
  }
}

/**
 * Build the default retrieval query for a turn: the actors the director wants
 * to advance, plus any open thread that is due. Those are the things an author
 * would go re-read the manuscript for.
 *
 * @param {Object} input
 * @param {import('../contracts/types.js').Canon} input.canon
 * @param {Array} [input.openSeeds]
 * @param {string[]} [input.entityIds]
 * @returns {string}
 */
export function buildQuery({ canon, openSeeds = [], entityIds = [] }) {
  const names = entityIds.map(id => {
    const e = canon.entities.find(x => x.id === id);
    return e ? e.name : '';
  }).filter(Boolean);

  const seedText = openSeeds.slice(0, 3).map(s => s.text).join(' ');

  return [names.join(' '), seedText].filter(Boolean).join(' ');
}

export function createRetriever(options) {
  return new KeywordRetriever(options);
}
