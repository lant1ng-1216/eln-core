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
 * The check requires a browser-ish global rather than merely probing for
 * `localStorage`: Node 22+ exposes an experimental `localStorage` that warns on
 * use and may be backed by a temp file, so `typeof localStorage !== 'undefined'`
 * would silently pick the wrong backend on a server. Pass an adapter explicitly
 * if you want disk or database persistence on Node.
 *
 * @returns {import('./memory-storage.js').StorageAdapter}
 */
export function createDefaultStorage() {
  const browserStorage = typeof window !== 'undefined' ? window.localStorage : undefined;
  if (browserStorage && typeof browserStorage.getItem === 'function') {
    try {
      return new LocalStorageStorage(browserStorage);
    } catch {
      // Fall through to memory on any environment quirk.
    }
  }
  return new MemoryStorage();
}
