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
import { diffUsage, sumUsage } from './transport/usage.js';
import { runTurn as runTurnTransaction } from './orchestration/turn.js';
import { Director } from './orchestration/director.js';
import { ContinuityGuard } from './orchestration/guard.js';
import { canonFromGeneratedWorld, resolveRef, secretsOf, entityByName, cloneCanon } from './state/canon.js';
import { createMinds, mindFor, adjustTrust, cloneMinds, setTrust } from './state/mind.js';
import { createLedgers, addSeed } from './state/ledger.js';
import { applyDelta } from './state/commit.js';
import { VersionStore } from './state/version.js';
import { projectCanon } from './mind/project.js';
import { openSeeds } from './state/ledger.js';
import { validateGeneratedWorld } from './contracts/validate.js';
import { createDefaultStorage } from './memory/adapters/index.js';
import { saveWorld, loadWorld, loadWorlds, deleteWorld } from './memory/store.js';
import { ProseStore } from './memory/prose.js';
import { KeywordRetriever, buildQuery } from './memory/retriever.js';
import { tokenSet } from './memory/keywords.js';
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
   * @param {Function} [options.onChapterEnd] - Fired when a chapter closes itself
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
      maxRewrites = 1,
      fetchImpl,
      onToken, onLine, onTurnEnd, onEvent, onChapterEnd, onRewrite,
    } = options;

    const clientOpts = { apiKey, apiBase, fetchImpl };
    const narrativeModel = models.narrative ?? model;
    const extractionModel = models.extraction ?? models.narrative ?? model;

    this._narrativeClient = new LLMClient({ ...clientOpts, model: narrativeModel });
    this._extractionClient = new LLMClient({ ...clientOpts, model: extractionModel });
    // The director's and critic's calls are optional and never load-bearing, so
    // a model is only wired up when one is explicitly configured.
    this._directorClient = models.director
      ? new LLMClient({ ...clientOpts, model: models.director })
      : null;
    this._criticClient = models.critic
      ? new LLMClient({ ...clientOpts, model: models.critic })
      : null;

    this._packs = packs;
    this._mode = mode;
    this._playerEntityId = playerEntityId;
    this._storage = storage ?? createDefaultStorage();
    this._prose = new ProseStore();
    this._retriever = retriever ?? new KeywordRetriever({ store: this._prose });
    // A caller-supplied retriever may not know about our prose store yet.
    this._retriever.attach?.(this._prose);
    this._director = new Director({
      client: this._directorClient,
      model: models.director ?? null,
    });
    this._guard = new ContinuityGuard({
      client: this._criticClient,
      model: models.critic ?? null,
    });
    this._maxRepair = maxRepair;
    this._maxRewrites = maxRewrites;

    this._onToken = onToken ?? null;
    this._onLine = onLine ?? null;
    this._onTurnEnd = onTurnEnd ?? null;
    this._onEvent = onEvent ?? null;
    this._onChapterEnd = onChapterEnd ?? null;
    this._onRewrite = onRewrite ?? null;

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
   *
   * Switching modes is a *projection* change, not a state change (DESIGN §3):
   * the same Canon and the same Minds are read through a different lens, so
   * round-tripping is lossless.
   *
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
    if (mode === 'character') {
      const id = playerEntityId ?? this._playerEntityId;
      if (this._canon && !this._canon.entities.some(e => e.id === id)) {
        throw new Error(`[ELN] Unknown playerEntityId "${id}". Use createPlayer() or pass an existing character id.`);
      }
    }
    this._mode = mode;
    if (playerEntityId !== undefined) this._playerEntityId = playerEntityId;
  }

  /**
   * Add a player character to the current world.
   *
   * The player is an ordinary entity with a Mind of its own — the engine only
   * narrates from their viewpoint. Nothing special-cases them, which is why
   * switching into character mode cannot leak information: there is no
   * "player privileges" path to leak through.
   *
   * @param {{name: string, role?: string, personality?: string, goal?: string, weightTag?: string}} input
   * @returns {object} the created entity
   */
  createPlayer({ name, role = '', personality = '', goal = '', weightTag = '男主' } = {}) {
    if (!this._canon) throw new Error('[ELN] No world loaded.');
    if (!name) throw new Error('[ELN] createPlayer requires a name');
    if (this.getCharacter(name)) throw new Error(`[ELN] Character already exists: ${name}`);

    const canon = cloneCanon(this._canon);
    const id = `p${canon.entities.filter(e => e.tags?.includes('player')).length + 1}`;

    canon.entities.push({
      id,
      kind: 'character',
      name,
      role,
      personality,
      goal,
      alive: true,
      emotion: '平静',
      weightTag,
      tags: ['player'],
    });

    const minds = cloneMinds(this._minds);
    const trust = {};
    for (const other of canon.entities) {
      if (other.id === id || other.kind !== 'character') continue;
      trust[other.id] = { value: 30, evidence: [] };
      const otherMind = mindFor(minds, other.id);
      if (otherMind && !otherMind.trust[id]) setTrust(otherMind, id, 30, canon.turn);
    }
    minds.set(id, { holderId: id, knows: [], suspects: [], believesFalse: [], trust });

    this._canon = canon;
    this._minds = minds;
    this._canon.version = this._versions.commit(this._snapshotState());

    return canon.entities[canon.entities.length - 1];
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
    this._prose = new ProseStore();
    this._retriever.attach?.(this._prose);
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
    this._prose = state.prose ?? new ProseStore();
    this._retriever.attach?.(this._prose);
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
    if (action && this._mode === 'director') {
      throw new Error(
        '[ELN] `action` is character-mode only. Use `intervention` in director mode, ' +
        'or call `setMode(\'character\', playerEntityId)` first.'
      );
    }

    this._isRunning = true;
    const usageBefore = this._usageSnapshot();

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
        onRewrite: this._onRewrite,
        guard: this._guard,
        maxRewrites: this._maxRewrites,
        buildRetrieved: ({ canon, beatSpec }) => this._buildRetrieved({
          canon,
          beatSpec,
          entityIds: beatSpec?.mustAdvance ?? [],
        }),
        mentionsOf: seed => this._mentionCount(seed),
        budget: null,
        maxRepair: this._maxRepair,
        signal,
        extraNotes: this._chapterHint ? [`本章聚焦：${this._chapterHint}`] : [],
      });

      // Retain the prose *before* committing, so this version's snapshot
      // includes the turn it just wrote. Otherwise checking out this version
      // would restore the canon but not the manuscript that produced it.
      this._prose.append(state.canon.turn, turnResult.narrativeText, {
        entityIds: this._entitiesIn(turnResult.narrativeText),
        chapter: state.canon.chapterIndex,
      });

      // Commit a version only after the whole transaction succeeded.
      state.canon.version = this._versions.commit({
        canon: state.canon,
        minds: state.minds,
        ledgers: state.ledgers,
        turnRecords: state.turnRecords,
        prose: this._prose,
      });

      this._canon = state.canon;
      this._minds = state.minds;
      this._ledgers = state.ledgers;
      this._turnRecords = state.turnRecords;

      this._directives = {};
      this._chapterHint = '';

      // Attach the observable cost of this turn (DESIGN §9 P4).
      turnResult.usage = diffUsage(usageBefore, this._usageSnapshot());

      if (turnResult.chapterTransition) this._onChapterEnd?.(turnResult.chapterTransition);
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
    this._prose = restored.prose ? ProseStore.fromJSON(restored.prose) : new ProseStore();
    this._retriever.attach?.(this._prose);
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
      prose: this._prose,
    };
  }

  /**
   * How often a seed's wording has resurfaced in the prose. Feeds the
   * deterministic urgency formula — a thread that keeps being mentioned is
   * closer to payoff than one that was planted and forgotten.
   *
   * @param {{text: string}} seed
   * @returns {number}
   */
  _mentionCount(seed) {
    const tokens = tokenSet(seed.text);
    if (!tokens.size) return 0;
    let hits = 0;
    for (const record of this._prose.all()) {
      const recordTokens = tokenSet(record.text);
      for (const token of tokens) {
        if (recordTokens.has(token)) { hits += 1; break; }
      }
    }
    return hits;
  }

  /**
   * Retrieve prose relevant to the beat about to be written. This is what lets
   * turn 20 quote a detail planted in turn 3 — the engine goes back and re-reads
   * its own manuscript instead of trusting a three-line summary.
   */
  _buildRetrieved({ canon, beatSpec, entityIds = [] }) {
    if (!this._retriever) return [];
    const seeds = openSeeds(this._ledgers ?? createLedgers());
    const query = buildQuery({ canon, openSeeds: seeds, entityIds });
    if (!query.trim()) return [];

    // Never retrieve the turns already in the prompt as recent summaries.
    const excludeTurns = this._turnRecords.slice(-3).map(t => t.turn);
    return this._retriever.retrieve(query, {
      limit: 3,
      entityIds,
      excludeTurns,
    });
  }

  /** Names appearing in `text`, resolved to entity ids. */
  _entitiesIn(text) {
    if (!text || !this._canon) return [];
    return this._canon.entities
      .filter(e => e.name && text.includes(e.name))
      .map(e => e.id);
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

  /**
   * Plant a foreshadowing thread deliberately. The extraction model plants
   * threads on its own; this is the authoring control for when the director
   * wants a specific promise made.
   *
   * @param {string} text
   * @param {{kind?: string, holderIds?: string[]}} [options]
   */
  plantSeed(text, { kind = 'question', holderIds = [] } = {}) {
    if (!this._canon) throw new Error('[ELN] No world loaded.');
    return addSeed(this._ledgers, {
      id: `sd_authored_${this._ledgers.seeds.length + 1}`,
      plantedTurn: this._canon.turn,
      text,
      kind,
      holderIds: holderIds.map(h => resolveRef(this._canon, h)),
      status: 'open',
      urgency: 0,
    });
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

  /** Cumulative token usage across every model role. */
  _usageSnapshot() {
    return sumUsage(
      this._narrativeClient.usage.snapshot(),
      this._extractionClient.usage.snapshot(),
      this._directorClient?.usage.snapshot(),
      this._criticClient?.usage.snapshot(),
    );
  }

  /**
   * Token usage so far, per model role and in total. `estimated: true` means at
   * least one figure was inferred because the provider did not report it.
   */
  get usage() {
    const byRole = {
      narrative: this._narrativeClient.usage.snapshot(),
      extraction: this._extractionClient.usage.snapshot(),
    };
    if (this._directorClient) byRole.director = this._directorClient.usage.snapshot();
    if (this._criticClient) byRole.critic = this._criticClient.usage.snapshot();

    return { ...this._usageSnapshot(), byRole };
  }

  /** Forget accumulated usage counters. */
  resetUsage() {
    for (const client of [this._narrativeClient, this._extractionClient, this._directorClient, this._criticClient]) {
      client?.resetUsage();
    }
    return this;
  }

  /** The retained prose. Read a past turn with `eln.prose.get(turn)`. */
  get prose() { return this._prose; }

  /** The active retrieval adapter (default: keyword + entity overlap). */
  get retriever() { return this._retriever; }

  /** Search retained prose directly. */
  searchProse(query, options) {
    return this._retriever?.retrieve(query, options) ?? [];
  }
}
