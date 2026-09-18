/**
 * ELN Core — Memory / Adapters barrel
 *
 * Storage is an adapter, never a hard dependency (DESIGN §1, §7). Bring your own
 * Redis/Postgres/Cloudflare-KV adapter by implementing `StorageAdapter`.
 */

export { MemoryStorage } from './memory-storage.js';
export { LocalStorageStorage } from './localstorage-storage.js';

import { MemoryStorage } from './memory-storage.js';
import { LocalStorageStorage } from './localstorage-storage.js';

/**
 * Pick a sensible default backend: browser → localStorage, Node → memory.
 *
 * This is what keeps `save()` working on the server instead of throwing the
 * `ReferenceError` 0.1.0 hit.
 *
 * @returns {import('./memory-storage.js').StorageAdapter}
 */
export function createDefaultStorage() {
  const ls = globalThis.localStorage;
  if (ls && typeof ls.getItem === 'function') {
    try {
      return new LocalStorageStorage(ls);
    } catch {
      // Fall through to memory on any environment quirk.
    }
  }
  return new MemoryStorage();
}
