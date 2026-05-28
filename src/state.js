/**
 * ELN Core — State Manager
 *
 * Pure functions for creating and mutating world state.
 * No side effects, no DOM, no fetch — just data.
 */

// ── World initialization ──

/**
 * Convert raw LLM-generated world data into runtime state.
 *
 * @param {import('./types.js').GeneratedWorld} generatedWorld
 * @returns {{ worldState: import('./types.js').WorldState, characters: import('./types.js').Character[], chapters: import('./types.js').Chapter[] }}
 */
export function initFromGeneratedWorld(generatedWorld) {
  const characters = generatedWorld.characters.map(c => ({
    ...c,
    trigger: 'ai',
    alive: true,
    emotion: '平静',
    trustWith: {},
  }));

  // Initialize mutual trust values
  characters.forEach((c, i) => {
    characters.forEach((d, j) => {
      if (i !== j) {
        c.trustWith[d.name] = 30 + Math.floor(Math.random() * 40);
      }
    });
  });

  const chapters = generatedWorld.chapters.map((ch, idx) => ({
    id: idx,
    name: ch.name,
    goal: ch.goal,
    targetTurns: 5,
    completedTurns: 0,
    status: idx === 0 ? 'active' : 'locked',
    beats: [],
  }));

  const worldState = {
    id: Date.now().toString(),
    name: generatedWorld.name,
    background: generatedWorld.background,
    outline: generatedWorld.outline ?? '',
    turn: 0,
    currentChapter: 0,
    time: '未定',
    location: '未定',
    tension: 30,
    _nextChapterHint: '',
  };

  return { worldState, characters, chapters };
}

/**
 * Apply a state-update JSON (returned by callStateUpdate) to current state.
 * Returns new copies — does not mutate in place.
 *
 * @param {object}                           stateUpdate   - Parsed JSON from LLM
 * @param {import('./types.js').WorldState}  worldState
 * @param {import('./types.js').Character[]} characters
 * @param {import('./types.js').Chapter[]}   chapters
 * @param {string}                           narrativeText - Full narrative text
 * @returns {{ worldState, characters, chapters, turnRecord, secretReveals, editorNote }}
 */
export function applyStateUpdate(stateUpdate, worldState, characters, chapters, narrativeText) {
  // Deep clone to avoid mutation
  const nextChars = JSON.parse(JSON.stringify(characters));
  const nextChapters = JSON.parse(JSON.stringify(chapters));
  const nextWorld = { ...worldState };

  // Apply character updates
  stateUpdate.characters?.forEach(upd => {
    const c = nextChars.find(c => c.name === upd.name);
    if (!c) return;
    if (upd.emotion) c.emotion = upd.emotion;
    if (upd.goal)    c.goal = upd.goal;
    if (upd.alive === false) c.alive = false;
    if (upd.trust_changes) {
      Object.entries(upd.trust_changes).forEach(([k, delta]) => {
        c.trustWith[k] = Math.max(0, Math.min(100, (c.trustWith[k] ?? 30) + delta));
      });
    }
  });

  // Apply world updates
  const w = stateUpdate.world;
  if (w) {
    if (w.location) nextWorld.location = w.location;
    if (w.time)     nextWorld.time = w.time;
    if (w.tension !== undefined) nextWorld.tension = w.tension;
  }

  // Record chapter beat
  const ch = nextChapters[nextWorld.currentChapter];
  if (ch) {
    ch.beats.push({ done: true, tension: nextWorld.tension });
  }

  // Apply secret reveal trust boosts
  const secretReveals = stateUpdate.reveals_secret ?? [];
  secretReveals.forEach(rv => {
    const from = nextChars.find(c => c.name === rv.from);
    if (from && from.trustWith[rv.to] !== undefined) {
      from.trustWith[rv.to] = Math.min(100, from.trustWith[rv.to] + 10);
    }
  });

  // Build turn record
  const turnRecord = {
    turn: nextWorld.turn,
    chapter: nextWorld.currentChapter,
    tension: nextWorld.tension,
    summary: stateUpdate.summary ?? '',
  };

  return {
    worldState: nextWorld,
    characters: nextChars,
    chapters: nextChapters,
    turnRecord,
    secretReveals,
    editorNote: stateUpdate.editor?.note ?? null,
    suggestClose: stateUpdate.editor?.suggest_close_chapter ?? false,
  };
}

// ── Chapter management ──

/**
 * Advance to the next chapter, if available.
 *
 * @param {import('./types.js').WorldState}  worldState
 * @param {import('./types.js').Chapter[]}   chapters
 * @param {string} [hint] - Optional hint for the next chapter direction
 * @returns {{ worldState, chapters, advanced: boolean }}
 */
export function advanceChapter(worldState, chapters, hint = '') {
  const nextWorld = { ...worldState };
  const nextChapters = JSON.parse(JSON.stringify(chapters));

  const current = nextChapters[nextWorld.currentChapter];
  if (current) current.status = 'done';

  const next = nextChapters[nextWorld.currentChapter + 1];
  if (!next) {
    return { worldState: nextWorld, chapters: nextChapters, advanced: false };
  }

  next.status = 'active';
  nextWorld.currentChapter++;
  if (hint) nextWorld._nextChapterHint = hint;

  return { worldState: nextWorld, chapters: nextChapters, advanced: true };
}

// ── Snapshot ──

/**
 * Create a snapshot of current state.
 *
 * @param {import('./types.js').WorldState}  worldState
 * @param {import('./types.js').Character[]} characters
 * @param {import('./types.js').Chapter[]}   chapters
 * @param {import('./types.js').TurnRecord[]} turns
 * @returns {import('./types.js').Snapshot}
 */
export function createSnapshot(worldState, characters, chapters, turns) {
  return {
    turn: worldState.turn,
    worldState: JSON.parse(JSON.stringify(worldState)),
    characters: JSON.parse(JSON.stringify(characters)),
    chapters: JSON.parse(JSON.stringify(chapters)),
    turns: [...turns],
  };
}

/**
 * Restore state from a snapshot.
 *
 * @param {import('./types.js').Snapshot} snapshot
 * @returns {{ worldState, characters, chapters, turns }}
 */
export function restoreSnapshot(snapshot) {
  return {
    worldState: JSON.parse(JSON.stringify(snapshot.worldState)),
    characters: JSON.parse(JSON.stringify(snapshot.characters)),
    chapters: JSON.parse(JSON.stringify(snapshot.chapters)),
    turns: [...snapshot.turns],
  };
}

// ── Persistence (localStorage) ──

const STORAGE_KEY_PREFIX = 'eln_worlds_';

/**
 * Save current world to localStorage.
 *
 * @param {string}                           userId
 * @param {import('./types.js').WorldState}  worldState
 * @param {import('./types.js').Character[]} characters
 * @param {import('./types.js').Chapter[]}   chapters
 */
export function saveWorld(userId, worldState, characters, chapters) {
  const key = STORAGE_KEY_PREFIX + userId;
  let worlds = [];
  try { worlds = JSON.parse(localStorage.getItem(key) ?? '[]'); } catch {}

  const worldData = {
    id: worldState.id ?? (worldState.id = Date.now().toString()),
    name: worldState.name ?? '未命名世界',
    background: (worldState.background ?? '').substring(0, 200),
    turns: worldState.turn ?? 0,
    targetTurns: chapters.reduce((s, c) => s + c.targetTurns, 0),
    charCount: characters.length,
    characters: characters.map(c => c.name),
    completedChapters: chapters.filter(c => c.status === 'done').length,
    completed: chapters.every(c => c.status === 'done'),
    updatedAt: Date.now(),
    snapshot: {
      worldState: JSON.parse(JSON.stringify(worldState)),
      characters: JSON.parse(JSON.stringify(characters)),
      chapters: JSON.parse(JSON.stringify(chapters)),
    },
  };

  const idx = worlds.findIndex(w => w.id === worldData.id);
  if (idx >= 0) { worlds[idx] = worldData; } else { worlds.push(worldData); }
  localStorage.setItem(key, JSON.stringify(worlds));
}

/**
 * Load all worlds for a user from localStorage.
 *
 * @param {string} userId
 * @returns {Array}
 */
export function loadWorlds(userId) {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_PREFIX + userId) ?? '[]');
  } catch {
    return [];
  }
}
