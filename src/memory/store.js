/**
 * ELN Core — Memory / World store
 *
 * Persistence for a whole runtime state through a `StorageAdapter`. Serializes
 * the things JSON cannot hold directly (the `minds` Map) and re-validates Canon
 * on load, so a corrupted or hand-edited save fails loudly at the boundary
 * instead of producing a half-broken world.
 */

import { validateCanon } from '../contracts/validate.js';
import { MemoryStorage } from './adapters/memory-storage.js';
import { ProseStore } from './prose.js';

const keyFor = userId => `worlds:${userId}`;

// ── Serialization ────────────────────────────────────────────────────────────

/** @returns {object} a JSON-safe view of the runtime state */
export function serializeState({ canon, minds, ledgers, turnRecords = [], prose = null }) {
  return {
    canon: structuredClone(canon),
    minds: [...minds].map(([id, mind]) => [id, structuredClone(mind)]),
    ledgers: structuredClone(ledgers ?? { events: [], seeds: [] }),
    turnRecords: structuredClone(turnRecords),
    // Prose is the bulkiest part of a save and also the most valuable: without
    // it a reloaded world forgets everything it ever wrote.
    prose: prose ? prose.toJSON() : null,
  };
}

/** @returns {{canon, minds: Map, ledgers, turnRecords, prose}} */
export function deserializeState(payload) {
  return {
    canon: validateCanon(payload.canon),
    minds: new Map((payload.minds ?? []).map(([id, mind]) => [id, mind])),
    ledgers: payload.ledgers ?? { events: [], seeds: [] },
    turnRecords: payload.turnRecords ?? [],
    prose: payload.prose ? ProseStore.fromJSON(payload.prose) : new ProseStore(),
  };
}

/** Compact row shown in a world list. */
export function worldSummary(state) {
  const { canon } = state;
  return {
    id: canon.id,
    name: canon.meta.name,
    tag: canon.meta.tag,
    background: canon.meta.background.slice(0, 120),
    turn: canon.turn,
    version: canon.version,
    currentChapter: canon.chapterIndex,
    chapterCount: canon.chapters.length,
    charCount: canon.entities.filter(e => e.kind === 'character').length,
    openSeeds: (state.ledgers?.seeds ?? []).filter(s => s.status === 'open').length,
    proseRecords: state.prose?.size ?? 0,
    updatedAt: Date.now(),
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

async function readAll(storage, userId) {
  const raw = await storage.get(keyFor(userId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Save (upsert) a world for `userId`.
 * @param {import('./adapters/memory-storage.js').StorageAdapter} storage
 */
export async function saveWorld(storage, userId, state) {
  const worlds = await readAll(storage, userId);
  const record = { ...worldSummary(state), snapshot: serializeState(state) };
  const idx = worlds.findIndex(w => w.id === record.id);
  if (idx >= 0) worlds[idx] = record; else worlds.push(record);
  await storage.set(keyFor(userId), JSON.stringify(worlds));
  return record.id;
}

/**
 * List saved worlds (summaries only, newest first).
 * @returns {Promise<Array>}
 */
export async function loadWorlds(storage, userId) {
  const worlds = await readAll(storage, userId);
  return worlds
    .map(({ snapshot, ...summary }) => summary)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * Load a full world's state by id. Omit `worldId` to load the most recent.
 * @returns {Promise<{canon, minds, ledgers, turnRecords}|null>}
 */
export async function loadWorld(storage, userId, worldId = null) {
  const worlds = await readAll(storage, userId);
  const record = worldId
    ? worlds.find(w => w.id === worldId)
    : worlds.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  if (!record?.snapshot) return null;
  return deserializeState(record.snapshot);
}

export async function deleteWorld(storage, userId, worldId) {
  const worlds = await readAll(storage, userId);
  const next = worlds.filter(w => w.id !== worldId);
  if (next.length === worlds.length) return false;
  await storage.set(keyFor(userId), JSON.stringify(next));
  return true;
}

export { MemoryStorage };
