/**
 * ELN Core — Runtime
 *
 * The main entry point. Orchestrates world generation, turn execution,
 * state updates, and snapshot management.
 *
 * Usage:
 *   import { ELNRuntime } from './src/runtime.js'
 *
 *   const eln = new ELNRuntime({ apiKey: 'sk-...' })
 *
 *   // Generate a world
 *   const world = await eln.generateWorld('ancient')
 *   eln.loadWorld(world)
 *
 *   // Run a turn
 *   const result = await eln.runTurn()
 *
 *   // Get current state
 *   const { worldState, characters, chapters } = eln.getState()
 */

import { LLMClient } from './llm-client.js';
import { buildWorldGenPrompt, buildNarrativePrompt, buildStateUpdatePrompt } from './prompts.js';
import {
  initFromGeneratedWorld,
  applyStateUpdate,
  advanceChapter,
  createSnapshot,
  restoreSnapshot,
  saveWorld,
  loadWorlds,
} from './state.js';

export class ELNRuntime {
  /**
   * @param {import('./types.js').ELNRuntimeOptions} options
   */
  constructor(options = {}) {
    const { apiKey, model, apiBase, onToken, onLine, onTurnEnd } = options;

    this._client = new LLMClient({ apiKey, model, apiBase });

    // Callbacks
    this._onToken   = onToken   ?? null;
    this._onLine    = onLine    ?? null;
    this._onTurnEnd = onTurnEnd ?? null;

    // Runtime state
    this._worldState  = null;
    this._characters  = [];
    this._chapters    = [];
    this._turns       = [];
    this._snapshots   = [];
    this._directives  = {};  // per-character one-shot directives
    this._isRunning   = false;
  }

  // ── World Generation ──────────────────────────────────────────────────────

  /**
   * Generate a new world from a template key or free-form prompt.
   * Does NOT load the world — call loadWorld() after.
   *
   * @param {string|null} templateKey  - e.g. 'ancient', 'republican', 'mystery'
   * @param {string|null} userPrompt   - Free-form description
   * @returns {Promise<import('./types.js').GeneratedWorld>}
   */
  async generateWorld(templateKey = null, userPrompt = null) {
    if (!templateKey && !userPrompt) {
      throw new Error('[ELN] Provide either templateKey or userPrompt');
    }
    const prompt = buildWorldGenPrompt(templateKey, userPrompt);
    const text = await this._client.complete(prompt, 1200);
    return LLMClient.parseJSON(text);
  }

  /**
   * Initialize runtime state from a generated world.
   *
   * @param {import('./types.js').GeneratedWorld} generatedWorld
   */
  loadWorld(generatedWorld) {
    const { worldState, characters, chapters } = initFromGeneratedWorld(generatedWorld);
    this._worldState = worldState;
    this._characters = characters;
    this._chapters   = chapters;
    this._turns      = [];
    this._snapshots  = [];
    this._directives = {};
  }

  /**
   * Load previously saved state directly (e.g. from localStorage).
   *
   * @param {object} snapshot  - { worldState, characters, chapters }
   */
  loadSnapshot(snapshot) {
    const restored = restoreSnapshot(snapshot);
    this._worldState = restored.worldState;
    this._characters = restored.characters;
    this._chapters   = restored.chapters;
    this._turns      = restored.turns;
  }

  // ── Turn Execution ────────────────────────────────────────────────────────

  /**
   * Run one turn: stream narrative, then extract state update.
   *
   * @param {object} [options]
   * @param {string} [options.intervention]  - God-mode event injection
   * @returns {Promise<import('./types.js').TurnResult>}
   */
  async runTurn(options = {}) {
    if (this._isRunning) throw new Error('[ELN] A turn is already running');
    if (!this._worldState) throw new Error('[ELN] No world loaded. Call loadWorld() first.');

    this._isRunning = true;
    const { intervention = '' } = options;

    // Advance turn counter
    this._worldState.turn++;
    const ch = this._chapters[this._worldState.currentChapter];
    if (ch) ch.completedTurns++;

    // Consume one-shot chapter hint
    const hint = this._worldState._nextChapterHint;
    setTimeout(() => { this._worldState._nextChapterHint = ''; }, 0);

    try {
      // ── Step 1: Streaming narrative ──
      const narrativePrompt = buildNarrativePrompt(
        this._worldState,
        this._characters,
        this._chapters,
        this._turns,
        { intervention, charDirectives: this._directives }
      );
      this._directives = {};  // clear one-shot directives

      let lineBuffer = '';
      const narrativeText = await this._client.stream(
        narrativePrompt,
        delta => {
          this._onToken?.(delta);
          lineBuffer += delta;
          const parts = lineBuffer.split('\n');
          for (let i = 0; i < parts.length - 1; i++) {
            const line = parts[i].trim();
            if (line) this._onLine?.(line);
          }
          lineBuffer = parts[parts.length - 1];
        },
        3000
      );
      // Flush last line
      if (lineBuffer.trim()) this._onLine?.(lineBuffer.trim());

      // ── Step 2: Silent state update ──
      const statePrompt = buildStateUpdatePrompt(
        narrativeText,
        this._worldState,
        this._characters
      );
      const stateText = await this._client.complete(statePrompt, 800);
      const stateUpdate = LLMClient.parseJSON(stateText);

      // ── Step 3: Apply update ──
      const result = applyStateUpdate(
        stateUpdate,
        this._worldState,
        this._characters,
        this._chapters,
        narrativeText
      );

      this._worldState = result.worldState;
      this._characters = result.characters;
      this._chapters   = result.chapters;
      this._turns.push(result.turnRecord);

      const turnResult = {
        narrativeText,
        stateUpdate,
        worldState:    this._worldState,
        characters:    this._characters,
        chapters:      this._chapters,
        secretReveals: result.secretReveals,
        editorNote:    result.editorNote,
        suggestClose:  result.suggestClose,
        summary:       result.turnRecord.summary,
      };

      this._onTurnEnd?.(turnResult);
      return turnResult;

    } finally {
      this._isRunning = false;
    }
  }

  // ── God Mode Controls ─────────────────────────────────────────────────────

  /**
   * Set a one-shot directive for a specific character in the next turn.
   *
   * @param {string} characterName
   * @param {string} directive
   */
  setCharDirective(characterName, directive) {
    this._directives[characterName] = (this._directives[characterName] ?? '') + ' ' + directive;
  }

  /**
   * Force a character to reveal their secret to another character.
   *
   * @param {string} fromName
   * @param {string} toName
   */
  forceSecretReveal(fromName, toName) {
    const from = this._characters.find(c => c.name === fromName);
    if (!from) throw new Error(`[ELN] Character not found: ${fromName}`);
    this.setCharDirective(fromName, `本回合必须主动向${toName}透露你的秘密：${from.secret}`);
    // Nudge trust
    from.trustWith[toName] = Math.min(100, (from.trustWith[toName] ?? 30) + 15);
    const to = this._characters.find(c => c.name === toName);
    if (to) to.trustWith[fromName] = Math.min(100, (to.trustWith[fromName] ?? 30) + 10);
  }

  /**
   * Advance to next chapter.
   *
   * @param {string} [hint]
   * @returns {boolean} Whether advance was successful (false = story complete)
   */
  nextChapter(hint = '') {
    const { worldState, chapters, advanced } = advanceChapter(
      this._worldState,
      this._chapters,
      hint
    );
    this._worldState = worldState;
    this._chapters   = chapters;
    return advanced;
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  /**
   * Save a snapshot of current state.
   *
   * @returns {import('./types.js').Snapshot}
   */
  saveSnapshot() {
    const snap = createSnapshot(
      this._worldState,
      this._characters,
      this._chapters,
      this._turns
    );
    this._snapshots.push(snap);
    return snap;
  }

  /**
   * Rewind to a snapshot by index (default: last).
   *
   * @param {number} [index]
   */
  rewindTo(index) {
    const idx = index ?? this._snapshots.length - 1;
    const snap = this._snapshots[idx];
    if (!snap) throw new Error(`[ELN] No snapshot at index ${idx}`);
    // Save current as branch before rewinding
    this._snapshots.push(createSnapshot(
      this._worldState, this._characters, this._chapters, this._turns
    ));
    this.loadSnapshot(snap);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * Save world to localStorage.
   *
   * @param {string} [userId]  - Default: 'guest'
   */
  save(userId = 'guest') {
    saveWorld(userId, this._worldState, this._characters, this._chapters);
  }

  /**
   * Load all saved worlds from localStorage.
   *
   * @param {string} [userId]
   * @returns {Array}
   */
  static getSavedWorlds(userId = 'guest') {
    return loadWorlds(userId);
  }

  // ── State Access ──────────────────────────────────────────────────────────

  /**
   * Get a read-only snapshot of current runtime state.
   *
   * @returns {{ worldState, characters, chapters, turns, snapshots }}
   */
  getState() {
    return {
      worldState: this._worldState,
      characters: this._characters,
      chapters:   this._chapters,
      turns:      this._turns,
      snapshots:  this._snapshots,
    };
  }

  get isRunning()    { return this._isRunning; }
  get isWorldLoaded(){ return this._worldState !== null; }
}
