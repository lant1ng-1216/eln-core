/**
 * ELN Core — Memory / Storage adapters / localStorage
 *
 * Browser persistence. The adapter is async to match the interface even though
 * `localStorage` is synchronous, so callers never have to know which backend
 * they got.
 */

/** @implements {import('./memory-storage.js').StorageAdapter} */
export class LocalStorageStorage {
  /**
   * @param {Storage} [backing] - Defaults to `globalThis.localStorage`
   * @param {string} [prefix]   - Namespaces every key this adapter touches
   */
  constructor(backing = globalThis.localStorage, prefix = 'eln:') {
    if (!backing) throw new Error('[ELN] localStorage is not available in this environment');
    this._backing = backing;
    this._prefix = prefix;
  }

  _k(key) { return this._prefix + key; }

  async get(key) {
    return this._backing.getItem(this._k(key));
  }

  async set(key, value) {
    this._backing.setItem(this._k(key), String(value));
  }

  async remove(key) {
    this._backing.removeItem(this._k(key));
  }

  async keys() {
    const out = [];
    for (let i = 0; i < this._backing.length; i++) {
      const k = this._backing.key(i);
      if (k?.startsWith(this._prefix)) out.push(k.slice(this._prefix.length));
    }
    return out;
  }
}
