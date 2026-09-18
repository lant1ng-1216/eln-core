/**
 * ELN Core — Memory / Storage adapters / In-memory
 *
 * The default when no `localStorage` exists — i.e. everywhere in Node.
 *
 * 0.1.0 called the `localStorage` global directly from `state.js`, so `save()`
 * threw `ReferenceError: localStorage is not defined` on the server. Storage is
 * now an adapter resolved at construction time, so the Node path is simply a
 * different implementation rather than a broken one.
 */

/**
 * @typedef {Object} StorageAdapter
 * @property {(key: string) => Promise<string|null>} get
 * @property {(key: string, value: string) => Promise<void>} set
 * @property {(key: string) => Promise<void>} remove
 * @property {() => Promise<string[]>} keys
 */

/** In-process Map-backed storage. Useful for tests and Node. */
export class MemoryStorage {
  constructor(initial = {}) {
    this._map = new Map(Object.entries(initial));
  }

  async get(key) {
    return this._map.has(key) ? this._map.get(key) : null;
  }

  async set(key, value) {
    this._map.set(key, String(value));
  }

  async remove(key) {
    this._map.delete(key);
  }

  async keys() {
    return [...this._map.keys()];
  }
}
