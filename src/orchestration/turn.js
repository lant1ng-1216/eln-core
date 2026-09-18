/**
 * ELN Core — Orchestration / Turn
 *
 * One turn is one transaction (DESIGN §5.1):
 *
 *   1. director.plan        → BeatSpec
 *   2. assembleContext      → data blocks (projected through the active mode)
 *   3. narrative.stream     → prose, streamed to the caller token by token
 *   4. extract + repair     → validated StateDelta
 *   5. applyDelta           → next committed state
 *
 * Failure semantics — the fix for 0.1.0's counter drift:
 * the input state is never mutated. `applyDelta` works on clones, so if
 * streaming or extraction throws, the caller's `canon.turn` and
 * `chapter.completedTurns` are exactly where they were. Counters only ever
 * advance as part of a committed state.
 */

import { assembleContext } from '../expression/render.js';
import { compose, buildExtractionPrompt } from '../expression/compose.js';
import { applyDelta } from '../state/commit.js';
import { cloneCanon } from '../state/canon.js';
import { cloneMinds } from '../state/mind.js';
import { cloneLedgers, openSeeds } from '../state/ledger.js';
import { extractWithRepair } from './repair.js';
import { planBeat } from './director.js';
import { makeIdFactory } from '../state/canon.js';

/** Raised when a turn fails before commit. The state is untouched. */
export class TurnFailedError extends Error {
  constructor(message, { cause, phase } = {}) {
    super(message);
    this.name = 'TurnFailedError';
    this.cause = cause;
    this.phase = phase;
  }
}

/**
 * Split streamed text into lines without losing partial lines across chunks —
 * the same carry-over discipline the SSE parser uses.
 */
function createLineSplitter(onLine) {
  let buffer = '';
  return {
    push(delta) {
      buffer += delta;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (line) onLine?.(line);
      }
    },
    flush() {
      const line = buffer.trim();
      if (line) onLine?.(line);
      buffer = '';
    },
  };
}

/** Synthesize the ledger event for a god-mode intervention or player action. */
function injectedEvents({ intervention, action, turn, canon }) {
  const events = [];
  if (intervention) {
    events.push({
      kind: 'intervention',
      actors: [],
      location: canon.location,
      time: canon.time,
      summary: intervention,
      source: 'director',
    });
  }
  if (action) {
    events.push({
      kind: 'action',
      actors: [],
      location: canon.location,
      time: canon.time,
      summary: action,
      source: 'player',
    });
  }
  return events;
}

/**
 * @param {Object} input
 * @param {{canon: object, minds: Map, ledgers: object, turnRecords: Array}} input.state
 * @param {Array|Object} input.packs
 * @param {{stream: Function}} input.narrativeClient
 * @param {{complete: Function}} input.extractionClient
 * @param {import('./director.js').Director} [input.director]
 * @param {'director'|'character'} [input.mode]
 * @param {string} [input.holderId]
 * @param {string} [input.intervention]
 * @param {string} [input.action]
 * @param {Object<string,string>} [input.directives]
 * @param {Function} [input.onToken]
 * @param {Function} [input.onLine]
 * @param {Function} [input.onEvent]
 * @param {Function} [input.buildRetrieved]
 * @param {number|object} [input.budget]
 * @param {number} [input.maxRepair]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{state: object, turnResult: object}>}
 */
export async function runTurn({
  state,
  packs,
  narrativeClient,
  extractionClient,
  director = null,
  mode = 'director',
  holderId = null,
  intervention = '',
  action = '',
  directives = {},
  onToken,
  onLine,
  onEvent,
  buildRetrieved,
  budget = null,
  maxRepair = 1,
  signal,
  extraNotes = [],
} = {}) {
  if (!state?.canon) throw new Error('[ELN] No world loaded. Call loadWorld() first.');

  const canon = state.canon;

  // ── 1. Director plans the beat ──
  const beatSpec = planBeat(director, {
    canon,
    ledgers: state.ledgers,
    mode,
    holderId,
  });

  // Caller-supplied notes (e.g. a chapter hint from `nextChapter`) ride along
  // with the director's own constraints rather than becoming a separate block.
  if (extraNotes?.length) {
    beatSpec.constraintNotes = [...beatSpec.constraintNotes, ...extraNotes];
  }

  // ── 2. Assemble the projected context ──
  const retrieved = typeof buildRetrieved === 'function'
    ? buildRetrieved({ canon, turn: canon.turn + 1, mode, holderId })
    : [];

  const blocks = assembleContext({
    canon,
    minds: state.minds,
    mode,
    holderId,
    ledgers: state.ledgers,
    turnRecords: state.turnRecords ?? [],
    retrieved,
    intervention,
    directives,
    beatSpec,
    budget,
  });

  const narrativePrompt = compose(packs, blocks, { turn: canon.turn + 1 });

  // ── 3. Stream the narrative ──
  let narrativeText;
  try {
    const splitter = createLineSplitter(onLine);
    narrativeText = await narrativeClient.stream(
      narrativePrompt,
      delta => {
        onToken?.(delta);
        splitter.push(delta);
      },
      { maxTokens: 3000, signal }
    );
    splitter.flush();
  } catch (error) {
    throw new TurnFailedError(`[ELN] Narrative streaming failed: ${error.message}`, {
      cause: error,
      phase: 'narrative',
    });
  }

  // ── 4. Silent extraction, with one repair attempt ──
  const extractionPrompt = buildExtractionPrompt({
    narrative: narrativeText,
    canon,
    openSeeds: openSeeds(state.ledgers),
  });

  let extraction;
  try {
    extraction = await extractWithRepair({
      client: extractionClient,
      prompt: extractionPrompt,
      maxTokens: 900,
      maxRepair,
    });
  } catch (error) {
    throw new TurnFailedError(`[ELN] State extraction failed: ${error.message}`, {
      cause: error,
      phase: 'extraction',
    });
  }

  // ── 5. Commit (clones inside; input state untouched) ──
  const delta = { ...extraction.blocks };
  const injected = injectedEvents({ intervention, action, turn: canon.turn + 1, canon });
  if (injected.length) {
    delta.events = [...(delta.events ?? []), ...injected];
  }

  const committed = applyDelta({
    canon: cloneCanon(canon),
    minds: cloneMinds(state.minds),
    ledgers: cloneLedgers(state.ledgers),
    delta,
    narrative: narrativeText,
    degraded: extraction.degraded,
  });

  const nextState = {
    canon: committed.canon,
    minds: committed.minds,
    ledgers: committed.ledgers,
    turnRecords: [...(state.turnRecords ?? []), committed.turnRecord],
  };

  // Notify observers about events that entered the ledger this turn.
  const beforeIds = new Set(state.ledgers.events.map(e => e.id));
  for (const event of committed.ledgers.events) {
    if (!beforeIds.has(event.id)) onEvent?.(event);
  }

  const turnResult = {
    turn: committed.canon.turn,
    narrativeText,
    blocks,
    beatSpec,
    delta,
    degraded: extraction.degraded,
    extractionErrors: extraction.errors,
    repairAttempts: extraction.attempts,
    canon: committed.canon,
    minds: committed.minds,
    ledgers: committed.ledgers,
    secretReveals: committed.secretReveals,
    editor: committed.editor,
    summary: committed.turnRecord.summary,
  };

  return { state: nextState, turnResult };
}

export { makeIdFactory };
