/**
 * ELN Core — Memory / Prose store
 *
 * 0.1.0 discarded the narrative the moment the state JSON was extracted, which
 * made long-range payoff physically impossible: by turn 20, turn 3's prose no
 * longer existed anywhere.
 *
 * This store keeps the prose. It is deliberately dumb — an append-only ring of
 * `{turn, text, entityIds}` records. Search lives in `retriever.js` so the
 * storage format does not depend on the retrieval strategy.
 */

/**
 * @typedef {Object} ProseRecord
 * @property {number} turn
 * @property {string} text
 * @property {string[]} entityIds - Entities appearing in this turn
 * @property {number} [chapter]
 * @property {number} [timestamp]
 */

export class ProseStore {
  /**
   * @param {object} [options]
   * @param {number} [options.maxRecords] - Ring size; older prose is evicted
   */
  constructor({ maxRecords = 500 } = {}) {
    /** @type {ProseRecord[]} */
    this._records = [];
    this.maxRecords = maxRecords;
  }

  /**
   * Append one turn's prose.
   * Re-appending the same turn replaces it, so a re-run cannot duplicate.
   *
   * @param {number} turn
   * @param {string} text
   * @param {{entityIds?: string[], chapter?: number}} [meta]
   * @returns {ProseRecord}
   */
  append(turn, text, { entityIds = [], chapter } = {}) {
    const record = {
      turn,
      text,
      entityIds: [...new Set(entityIds)],
      chapter,
      timestamp: Date.now(),
    };

    const existing = this._records.findIndex(r => r.turn === turn);
    if (existing >= 0) this._records[existing] = record;
    else this._records.push(record);

    this._records.sort((a, b) => a.turn - b.turn);

    if (this._records.length > this.maxRecords) {
      this._records.splice(0, this._records.length - this.maxRecords);
    }
    return record;
  }

  /** @returns {ProseRecord|undefined} */
  get(turn) {
    return this._records.find(r => r.turn === turn);
  }

  /** All records, ascending by turn. */
  all() {
    return [...this._records];
  }

  /** The `n` most recent records, ascending. */
  last(n) {
    return this._records.slice(-n);
  }

  /** Records from a chapter. */
  byChapter(chapter) {
    return this._records.filter(r => r.chapter === chapter);
  }

  get size() { return this._records.length; }

  clear() { this._records = []; }

  /** JSON-safe payload for persistence. */
  toJSON() { return { maxRecords: this.maxRecords, records: this.all() }; }

  static fromJSON(payload) {
    const store = new ProseStore({ maxRecords: payload?.maxRecords ?? 500 });
    for (const r of payload?.records ?? []) store._records.push(r);
    return store;
  }
}
