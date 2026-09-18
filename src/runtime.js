/**
 * ELN Core — Runtime
 *
 * The single stateful entry point (DESIGN §1). Everything below it is pure or
 * injected; this class is the only place that holds mutable state across turns
 * and the only place a caller needs to know about.
 *
 * @example
 * import { ELNRuntime, genrePack, stylePack } from 'eln-core'
 *
 * const eln = new ELNRuntime({
 *   apiKey: 'sk-...',
 *   packs: [genrePack('republican'), stylePack('zh-literary')],
 *   onToken: t => process.stdout.write(t),
 * })
 *
 * const world = await eln.generateWorld({ genre: 'republican' })
 * eln.loadWorld(world)
 * await eln.runTurn()
 */

import { LLMClient } from './transport/llm-client.js';
import { runTurn as runTurnTransaction } from './orchestration/turn.js';
import { Director } from './orchestration/director.js';
import { canonFromGeneratedWorld, resolveRef, secretsOf, entityByName } from './state/canon.js';
import { createMinds, mindFor, adjustTrust } from './state/mind.js';
import { createLedgers } from './state/ledger.js';
import { applyDelta } from './state/commit.js';
import { VersionStore } from './state/version.js';
import { projectCanon } from './mind/project.js';
import { openSeeds } from './state/ledger.js';
import { validateGeneratedWorld } from './contracts/validate.js';
import { createDefaultStorage } from './memory/adapters/index.js';
import { saveWorld, loadWorld, loadWorlds, deleteWorld } from './memory/store.js';
import { buildWorldGenPrompt } from './expression/compose.js';

const DEFAULT_API_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

export class ELNRuntime {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.apiBase]
   * @param {string} [options.model]        - Single-model shorthand
   * @param {{narrative?: string, extraction?: string, director?: string, critic?: string}} [options.models]
   * @param {Array} [options.packs]
   * @param {'director'|'character'} [options.mode]
   * @param {string} [options.playerEntityId]
   * @param {object} [options.storage]
   * @param {object} [options.retriever]
   * @param {number} [options.maxRepair]
   * @param {Function} [options.onToken]
   * @param {Function} [options.onLine]
   * @param {Function} [options.onTurnEnd]
   * @param {Function} [options.onEvent]
   */
  constructor(options = {}) {
    const {
      apiKey,
      apiBase = DEFAULT_API_BASE,
      model = DEFAULT_MODEL,
      models = {},
      packs = [],
      mode = 'director',
      playerEntityId = null,
      storage,
      retriever = null,
      maxRepair = 1,
      fetchImpl,
      onToken, onLine, onTurnEnd, onEvent,
    } = options;

    const clientOpts = { apiKey, apiBase, fetchImpl };
    const narrativeModel = models.narrative ?? model;
    const extractionModel = models.extraction ?? models.narrative ?? model;

    this._narrativeClient = new LLMClient({ ...clientOpts, model: narrativeModel });
    this._extractionClient = new LLMClient({ ...clientOpts, model: extractionModel });

    this._packs = packs;
    this._mode = mode;
    this._playerEntityId = playerEntityId;
    this._storage = storage ?? createDefaultStorage();
    this._retriever = retriever;
    this._director = new Director();
    this._maxRepair = maxRepair;

    this._onToken = onToken ?? null;
    this._onLine = onLine ?? null;
    this._onTurnEnd = onTurnEnd ?? null;
    this._onEvent = onEvent ?? null;

    // State
    this._canon = null;
    this._minds = null;
    this._ledgers = null;
    this._turnRecords = [];
    this._versions = null;
    this._directives = {};
    this._chapterHint = '';
    this._isRunning = false;
  }

  // ── Configuration ─────────────────────────────────────────────────────────

  get mode() { return this._mode; }
  get playerEntityId() { return this._playerEntityId; }

  /**
   * Switch between `'director'` and `'character'`.
   * @param {'director'|'character'} mode
   * @param {string} [playerEntityId]
   */
  setMode(mode, playerEntityId) {
    if (mode !== 'director' && mode !== 'character') {
      throw new Error(`[ELN] Unknown mode "${mode}"`);
    }
    if (mode === 'character' && !(playerEntityId ?? this._playerEntityId)) {
      throw new Error('[ELN] character mode requires a playerEntityId');
    }
    this._mode = mode;
    if (playerEntityId !== undefined) this._playerEntityId = playerEntityId;
  }

  // ── World generation ───────────────────────────────────────────────────────

  /**
   * Generate a world. Does not load it — call `loadWorld()` after.
   *
   * @param {{genre?: string, prompt?: string}} [input]
   * @returns {Promise<object>} the validated generated world
   */
  async generateWorld(input = {}) {
    const args = typeof input === 'string' ? { genre: input } : input;
    const prompt = buildWorldGenPrompt(args);
    const text = await this._narrativeClient.complete(prompt, { maxTokens: 1600 });
    return validateGeneratedWorld(LLMClient.parseJSON(text));
  }

  /**
   * Initialize runtime state from a generated world.
   * @param {object} generatedWorld
   */
  loadWorld(generatedWorld) {
    const world = validateGeneratedWorld(generatedWorld);
    const canon = canonFromGeneratedWorld(world);
    this._canon = canon;
    this._minds = createMinds(canon);
    this._ledgers = createLedgers();
    this._turnRecords = [];
    this._versions = new VersionStore(this._snapshotState());
    this._directives = {};
    this._chapterHint = '';
    return this.getState();
  }

  /** Restore a previously saved state into the runtime. */
  loadState(state) {
    this._canon = state.canon;
    this._minds = state.minds;
    this._ledgers = state.ledgers ?? createLedgers();
    this._turnRecords = state.turnRecords ?? [];
    this._versions = new VersionStore(this._snapshotState());
    return this.getState();
  }

  // ── Turn execution ─────────────────────────────────────────────────────────

  /**
   * Run one turn. On any failure the state is left exactly as it was — turn
   * counters cannot drift (DESIGN §5.1).
   *
   * @param {object} [options]
   * @param {string} [options.intervention] - God-mode event (director mode only)
   * @param {string} [options.action]       - Player action (character mode)
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<object>} the turn result
   */
  async runTurn(options = {}) {
    if (this._isRunning) throw new Error('[ELN] A turn is already running');
    if (!this._canon) throw new Error('[ELN] No world loaded. Call loadWorld() first.');

    const { intervention = '', action = '', signal } = options;

    if (intervention && this._mode === 'character') {
      throw new Error(
        '[ELN] `intervention` is director-only. Use `action` in character mode, ' +
        'or `injectWorldEvent()` to change the world without leaking knowledge.'
      );
    }

    this._isRunning = true;
    try {
      const { state, turnResult } = await runTurnTransaction({
        state: {
          canon: this._canon,
          minds: this._minds,
          ledgers: this._ledgers,
          turnRecords: this._turnRecords,
        },
        packs: this._packs,
        narrativeClient: this._narrativeClient,
        extractionClient: this._extractionClient,
        director: this._director,
        mode: this._mode,
        holderId: this._playerEntityId,
        intervention,
        action,
        directives: this._directives,
        onToken: this._onToken,
        onLine: this._onLine,
        onEvent: this._onEvent,
        budget: null,
        maxRepair: this._maxRepair,
        signal,
        extraNotes: this._chapterHint ? [`本章聚焦：${this._chapterHint}`] : [],
      });

      // Commit a version only after the whole transaction succeeded.
      state.canon.version = this._versions.commit(state);

      this._canon = state.canon;
      this._minds = state.minds;
      this._ledgers = state.ledgers;
      this._turnRecords = state.turnRecords;
      this._directives = {};
      this._chapterHint = '';

      this._onTurnEnd?.(turnResult);
      return turnResult;
    } finally {
      this._isRunning = false;
    }
  }

  // ── God mode ───────────────────────────────────────────────────────────────

  /** Queue a one-shot directive for a character's next turn. */
  setCharDirective(characterName, directive) {
    this._directives[characterName] =
      `${this._directives[characterName] ?? ''} ${directive}`.trim();
    return this;
  }

  /**
   * Force a character to reveal a secret to another. This is a **state write**
   * (it adds the fact to the target's `knows`), not a prompt patch — the
   * mechanism that replaced 0.1.0's string injection (DESIGN §2.3).
   */
  forceSecretReveal(fromName, toName) {
    if (!this._canon) throw new Error('[ELN] No world loaded.');
    const fromId = resolveRef(this._canon, fromName);
    const toId = resolveRef(this._canon, toName);
    const from = this._canon.entities.find(e => e.id === fromId);
    const to = this._canon.entities.find(e => e.id === toId);
    if (!from) throw new Error(`[ELN] Character not found: ${fromName}`);
    if (!to) throw new Error(`[ELN] Character not found: ${toName}`);

    const secrets = secretsOf(this._canon, fromId);
    const toMind = mindFor(this._minds, toId);
    if (toMind) {
      for (const secret of secrets) {
        this._minds.set(toId, {
          ...toMind,
          knows: [
            ...toMind.knows.filter(r => r.factId !== secret.id),
            { factId: secret.id, confidence: 1, since: this._canon.turn, evidence: [this._canon.turn] },
          ],
        });
      }
      const target = this._minds.get(toId);
      adjustTrust(target, fromId, 10, this._canon.turn);
    }

    this.setCharDirective(from.name, `本回合必须主动向${to.name}透露你的秘密：${secrets.map(s => s.object).join('；')}`);
    return { from: fromId, to: toId, revealed: secrets.map(s => s.object) };
  }

  /**
   * Inject a world event without touching any Mind (DESIGN §10.5). This is the
   * character-mode-safe alternative to `intervention`: the world changes, but no
   * character learns anything they should not.
   */
  injectWorldEvent(summary, { kind = 'world' } = {}) {
    if (!this._canon) throw new Error('[ELN] No world loaded.');
    const committed = applyDelta({
      canon: this._canon,
      minds: this._minds,
      ledgers: this._ledgers,
      delta: {
        events: [{
          kind,
          actors: [],
          location: this._canon.location,
          time: this._canon.time,
          summary,
          source: 'director',
        }],
      },
    });
    // Take the ledger and turn counters, but leave Minds untouched.
    this._canon = committed.canon;
    this._ledgers = committed.ledgers;
    this._turnRecords = [...this._turnRecords, committed.turnRecord];
    this._canon.version = this._versions.commit(this._snapshotState());
    return committed.turnRecord;
  }

  /**
   * Advance to the next chapter. From P2 the engine also closes chapters
   * automatically; this becomes an override (DESIGN §7 breaking change).
   * @returns {boolean} false when the story has no further chapters
   */
  nextChapter(hint = '') {
    if (!this._canon) throw new Error('[ELN] No world loaded.');
    const idx = this._canon.chapterIndex;
    const next = this._canon.chapters[idx + 1];
    if (!next) return false;
    this._canon.chapters[idx].status = 'done';
    next.status = 'active';
    this._canon.chapterIndex = idx + 1;
    this._chapterHint = hint;
    return true;
  }

  // ── Branching ──────────────────────────────────────────────────────────────

  /**
   * Start a new world line from a version (default: current).
   * @returns {{lineId: string, version: number}}
   */
  branch({ from } = {}) {
    if (!this._versions) throw new Error('[ELN] No world loaded.');
    return this._versions.branch(from);
  }

  /**
   * Jump the current world line to a stored version.
   * Restores canon *and* minds/ledgers — a snapshot that only restored canon
   * would leave characters remembering a future that no longer happened.
   */
  checkout(versionId) {
    if (!this._versions) throw new Error('[ELN] No world loaded.');
    const restored = this._versions.checkout(versionId);
    this._canon = restored.canon;
    this._minds = restored.minds;
    this._ledgers = restored.ledgers;
    this._turnRecords = restored.turnRecords;
    return this._canon;
  }

  /** Version history of the current line. */
  history() {
    return this._versions?.history() ?? [];
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /** Save the current world. Resolves once the storage adapter has written. */
  async save(userId = 'guest') {
    if (!this._canon) throw new Error('[ELN] No world loaded.');
    return saveWorld(this._storage, userId, this._snapshotState());
  }

  /** Load a saved world by id (default: most recent). */
  async load(userId = 'guest', worldId = null) {
    const state = await loadWorld(this._storage, userId, worldId);
    if (!state) return null;
    this.loadState(state);
    return this.getState();
  }

  /** Summaries of saved worlds. */
  async listSavedWorlds(userId = 'guest') {
    return loadWorlds(this._storage, userId);
  }

  async deleteSavedWorld(userId = 'guest', worldId = '') {
    return deleteWorld(this._storage, userId, worldId);
  }

  /**
   * Static convenience for callers without a runtime instance.
   * @param {string} [userId]
   * @param {object} [storage]
   */
  static async getSavedWorlds(userId = 'guest', storage = createDefaultStorage()) {
    return loadWorlds(storage, userId);
  }

  _snapshotState() {
    return {
      canon: this._canon,
      minds: this._minds,
      ledgers: this._ledgers,
      turnRecords: this._turnRecords,
    };
  }

  // ── Read models ────────────────────────────────────────────────────────────

  /**
   * @param {{perspective?: string}} [options]
   *   `perspective` returns that holder's projected View instead of raw state.
   */
  getState({ perspective } = {}) {
    if (perspective) {
      return projectCanon(this._canon, mindFor(this._minds, perspective), 'character', perspective);
    }
    return {
      canon: this._canon,
      minds: this._minds,
      events: this._ledgers?.events ?? [],
      seeds: this._ledgers?.seeds ?? [],
      turns: this._turnRecords,
    };
  }

  /** Open/paid/abandoned seeds, filtered. */
  listSeeds({ status = 'open' } = {}) {
    const seeds = this._ledgers?.seeds ?? [];
    return status ? seeds.filter(s => s.status === status) : seeds;
  }

  /** Convenience: the open seeds, most urgent first (what the director sees). */
  getOpenSeeds() {
    return openSeeds(this._ledgers ?? createLedgers());
  }

  /** Resolve a character name to its entity. */
  getCharacter(nameOrId) {
    if (!this._canon) return undefined;
    return entityByName(this._canon, nameOrId)
      ?? this._canon.entities.find(e => e.id === nameOrId);
  }

  get isRunning() { return this._isRunning; }
  get isWorldLoaded() { return this._canon !== null; }
}
