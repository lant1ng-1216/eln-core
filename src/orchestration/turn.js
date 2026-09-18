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
import { cloneLedgers, openSeeds, addEvent } from '../state/ledger.js';
import { maybeCloseChapter } from '../state/chapter.js';
import { extractWithRepair } from './repair.js';
import { planBeat } from './director.js';
import { ContinuityGuard, describeViolations } from './guard.js';
import { makeIdFactory, currentChapter } from '../state/canon.js';

/** A chapter is "closing" once it has used 80% of its turn budget. */
const CHAPTER_END_RATIO = 0.8;

/**
 * Ask for a corrected retelling, carrying the concrete violations back to the
 * model. Generic advice ("be consistent") is ignored; a named contradiction is
 * usually fixed.
 */
function buildRewritePrompt(narrativePrompt, violations) {
  return `${narrativePrompt}

---
你上一次的产出有下列连续性问题，必须修正后**重写整段正文**（只输出小说正文，不要解释）：
${describeViolations(violations)}`;
}

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
function injectedEvents({ intervention, action, playerEntityId, canon }) {
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
      // The player is the actor — the ledger should make that traceable rather
      // than recording an orphaned event.
      actors: playerEntityId ? [playerEntityId] : [],
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
  onRewrite,
  guard = null,
  buildRetrieved,
  budget = null,
  maxRepair = 1,
  maxRewrites = 1,
  signal,
  extraNotes = [],
  mentionsOf = null,
} = {}) {
  if (!state?.canon) throw new Error('[ELN] No world loaded. Call loadWorld() first.');

  const canon = state.canon;

  // ── 0. The director reviews a player action before it can enter canon ──
  // Decision §10.4: accept by default, intervene only on a canon violation.
  // A rejected action aborts the turn before anything is written, so the state
  // the caller sees is unchanged and they can retry with a different intent.
  let reviewedAction = (action ?? '').trim();
  if (reviewedAction && mode === 'character' && typeof director?.reviewAction === 'function') {
    const review = director.reviewAction(reviewedAction, { canon, playerEntityId: holderId });
    if (!review.allowed) {
      throw new TurnFailedError(`[ELN] Player action rejected: ${review.reason}`, { phase: 'action' });
    }
    reviewedAction = review.action;
  }

  // ── 1. Director plans the beat ──
  let beatSpec = planBeat(director, {
    canon,
    ledgers: state.ledgers,
    mode,
    holderId,
    action: reviewedAction,
  });

  // Caller-supplied notes (e.g. a chapter hint from `nextChapter`) ride along
  // with the director's own constraints rather than becoming a separate block.
  if (extraNotes?.length) {
    beatSpec.constraintNotes = [...beatSpec.constraintNotes, ...extraNotes];
  }

  // Optional: let a cheap model add the parts a rule cannot decide. Never
  // load-bearing — `enrich` returns the deterministic beat on any failure.
  if (typeof director?.enrich === 'function') {
    beatSpec = await director.enrich(beatSpec, {
      canon,
      ledgers: state.ledgers,
      mode,
      holderId,
    });
  }

  // ── 2. Assemble the projected context ──
  // The beat decides what is worth re-reading: the actors whose goals must move
  // and the threads coming due.
  const retrieved = typeof buildRetrieved === 'function'
    ? buildRetrieved({ canon, turn: canon.turn + 1, mode, holderId, beatSpec })
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
  //
  // Tokens are forwarded as they arrive, so a rewrite necessarily reaches the
  // caller twice. `onRewrite` is the contract for that: a streaming consumer
  // clears its buffer and re-renders. Buffering the whole passage instead would
  // trade the product's only real-time feature for a rare correction.
  const streamOnce = async prompt => {
    const splitter = createLineSplitter(onLine);
    const text = await narrativeClient.stream(
      prompt,
      delta => {
        onToken?.(delta);
        splitter.push(delta);
      },
      { maxTokens: 3000, signal }
    );
    splitter.flush();
    return text;
  };

  const activeGuard = guard ?? new ContinuityGuard();

  let narrativeText;
  try {
    narrativeText = await streamOnce(narrativePrompt);
  } catch (error) {
    throw new TurnFailedError(`[ELN] Narrative streaming failed: ${error.message}`, {
      cause: error,
      phase: 'narrative',
    });
  }

  // ── 3b. Continuity check, then at most `maxRewrites` corrections ──
  let continuity = await activeGuard.review({
    narrative: narrativeText,
    canon,
    minds: state.minds,
    ledgers: state.ledgers,
    mode,
    holderId,
  });
  let rewrites = 0;

  while (!continuity.ok && rewrites < maxRewrites) {
    rewrites += 1;
    onRewrite?.({ attempt: rewrites, violations: continuity.violations });

    try {
      narrativeText = await streamOnce(buildRewritePrompt(narrativePrompt, continuity.violations));
    } catch (error) {
      // A failed rewrite keeps the first attempt rather than failing the turn.
      continuity = { ...continuity, rewriteError: String(error?.message ?? error) };
      break;
    }

    continuity = await activeGuard.review({
      narrative: narrativeText,
      canon,
      minds: state.minds,
      ledgers: state.ledgers,
      mode,
      holderId,
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
      // 900 was too small once facts started carrying an `evidence` quote: a
      // real extraction overran it, was truncated, and silently extracted
      // nothing. 2000 leaves room, and the prompt now states explicit caps.
      maxTokens: 2000,
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
  const injected = injectedEvents({
    intervention,
    action: reviewedAction,
    playerEntityId: mode === 'character' ? holderId : null,
    canon,
  });
  if (injected.length) {
    delta.events = [...(delta.events ?? []), ...injected];
  }

  const chapter = currentChapter(canon);
  const nearChapterEnd = chapter
    ? chapter.completedTurns / chapter.targetTurns >= CHAPTER_END_RATIO
    : false;

  const committed = applyDelta({
    canon: cloneCanon(canon),
    minds: cloneMinds(state.minds),
    ledgers: cloneLedgers(state.ledgers),
    delta,
    narrative: narrativeText,
    degraded: extraction.degraded,
    nearChapterEnd,
    mentionsOf,
    tensionTarget: beatSpec.tensionTarget,
    tensionBand: beatSpec.tensionBand,
  });

  // ── 6. Chapter lifecycle ──
  // The engine decides when a chapter is finished (DESIGN §4). Closing here,
  // inside the transaction, means the committed state already reflects the
  // transition — no external `nextChapter()` call is required.
  let chapterTransition = null;
  const closure = maybeCloseChapter(committed.canon, committed.ledgers, {
    editorSuggested: committed.editor?.suggest_close_chapter === true,
  });

  if (closure.closed) {
    committed.canon = closure.canon;
    const idf = makeIdFactory(committed.canon.turn);
    addEvent(committed.ledgers, {
      id: idf('ev'),
      turn: committed.canon.turn,
      kind: 'world',
      actors: [],
      location: committed.canon.location,
      time: committed.canon.time,
      summary: `《${closure.from.name}》收尾，进入《${closure.to.name}》`,
      source: 'director',
    });
    chapterTransition = {
      reason: closure.reason,
      from: closure.from.name,
      to: closure.to.name,
      index: closure.nextChapterIndex,
    };
    committed.turnRecord.chapterEnded = closure.from.name;
  }

  // A turn that still contradicts canon after its rewrite is committed anyway —
  // the prose exists and the state must stay in sync with it — but it is marked
  // so the caller can surface or reject it.
  if (!continuity.ok) {
    committed.turnRecord.continuityWarnings = continuity.violations
      .filter(v => v.severity === 'error')
      .map(v => v.detail);
  }

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
    /** The persisted record for this turn (also appended to `state.turns`). */
    turnRecord: committed.turnRecord,
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
    chapterTransition,
    action: reviewedAction,
    continuity: {
      ok: continuity.ok,
      violations: continuity.violations,
      rewrites,
      modelChecked: continuity.modelChecked ?? false,
      rewriteError: continuity.rewriteError,
    },
  };

  return { state: nextState, turnResult };
}

export { makeIdFactory };
