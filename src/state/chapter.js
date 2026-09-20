/**
 * ELN Core — State / Chapter lifecycle
 *
 * DESIGN §4: chapters close on *criteria*, not on someone remembering to call
 * `nextChapter()`. A chapter is ready to close when its declared criteria are
 * met (the seeds it promised to pay are paid, the goals it named are reached)
 * or when its turn budget runs out.
 *
 * `nextChapter()` survives as an override for the author, but the engine no
 * longer depends on it.
 */

import { currentChapter } from './canon.js';

/** Has the chapter used its whole turn budget? */
export function chapterBudgetExhausted(chapter) {
  if (!chapter) return false;
  return chapter.completedTurns >= chapter.targetTurns;
}

/** Fraction of the turn budget used, clamped to [0, 1]. */
export function chapterProgress(chapter) {
  if (!chapter || !chapter.targetTurns) return 0;
  return Math.max(0, Math.min(1, chapter.completedTurns / chapter.targetTurns));
}

/**
 * Evaluate a chapter's declared close criteria.
 *
 * A chapter with *no* declared criteria never closes on criteria — there is
 * nothing to satisfy, so only the turn budget can end it. Treating "no criteria"
 * as "satisfied" would close every chapter on its first turn.
 *
 * @returns {{declared: boolean, satisfied: boolean, reasons: string[], missing: string[]}}
 */
export function evaluateCloseCriteria(canon, ledgers, chapter = currentChapter(canon)) {
  const empty = { declared: false, satisfied: false, reasons: [], missing: [] };
  if (!chapter) return empty;

  const { seedsToPay = [], goalsToMeet = [] } = chapter.closeCriteria ?? {};
  if (!seedsToPay.length && !goalsToMeet.length) return empty;

  const reasons = [];
  const missing = [];

  for (const seedId of seedsToPay) {
    const seed = ledgers.seeds.find(s => s.id === seedId);
    if (seed && seed.status === 'paid') reasons.push(`伏笔已回收：${seed.text}`);
    else missing.push(`伏笔未回收：${seed?.text ?? seedId}`);
  }

  for (const goal of goalsToMeet) {
    const reached = canon.entities.some(e => e.kind === 'character' && e.goal?.includes(goal))
      || canon.facts.some(f => f.predicate === 'goal' && String(f.object).includes(goal));
    if (reached) reasons.push(`目标已达成：${goal}`);
    else missing.push(`目标未达成：${goal}`);
  }

  return { declared: true, satisfied: missing.length === 0, reasons, missing };
}

/**
 * Close the active chapter and activate the next one. Returns a new canon;
 * the input is not mutated.
 *
 * @returns {{canon: object, closed: boolean, reason: string, from?: object, to?: object, nextChapterIndex?: number}}
 */
export function closeChapter(canon, ledgers, { reason = '' } = {}) {
  const next = structuredClone(canon);
  const idx = next.chapterIndex;
  const current = next.chapters[idx];

  if (!current) return { canon, closed: false, reason: 'no active chapter' };
  const following = next.chapters[idx + 1];
  if (!following) return { canon, closed: false, reason: 'story complete' };

  current.status = 'done';
  following.status = 'active';
  // The next chapter starts on the turn about to be written.
  following.startedTurn = next.turn + 1;
  next.chapterIndex = idx + 1;
  next.tension = Math.max(5, Math.round(next.tension * 0.6));

  return {
    canon: next,
    closed: true,
    reason,
    from: current,
    to: following,
    nextChapterIndex: idx + 1,
  };
}

/**
 * Did this chapter resolve the threads it planted?
 *
 * This is the criteria source that works without an author declaring anything:
 * a chapter whose secrets and promises have all been paid off has told the story
 * it opened, so it may end. Without it, criteria-driven closing was unreachable
 * in practice — every real run closed on the turn budget alone, because nothing
 * ever populated `closeCriteria`.
 *
 * @returns {{planted: number, open: number, resolved: boolean, openTexts: string[]}}
 */
export function chapterThreads(canon, ledgers, chapter = currentChapter(canon)) {
  const empty = { planted: 0, open: 0, resolved: false, openTexts: [] };
  if (!chapter) return empty;

  const start = chapter.startedTurn ?? 1;
  const planted = (ledgers?.seeds ?? []).filter(
    s => s.plantedTurn >= start && s.plantedTurn <= canon.turn
  );
  const open = planted.filter(s => s.status === 'open');

  return {
    planted: planted.length,
    open: open.length,
    resolved: planted.length > 0 && open.length === 0,
    openTexts: open.map(s => s.text),
  };
}

/**
 * Close the chapter if it is ready. The engine calls this after every commit,
 * which is what removes the manual `nextChapter()` step from the loop.
 *
 * @param {Object} [options]
 * @param {boolean} [options.editorSuggested] - The extractor's `suggest_close_chapter`
 * @param {number} [options.minProgressForThreads] - Don't end a chapter early just
 *   because its threads resolved quickly; a story needs room to breathe
 * @returns {{canon: object, closed: boolean, reason: string}}
 */
export function maybeCloseChapter(
  canon,
  ledgers,
  { editorSuggested = false, minProgressForThreads = 0.5 } = {}
) {
  const chapter = currentChapter(canon);
  if (!chapter) return { canon, closed: false, reason: '' };

  const criteria = evaluateCloseCriteria(canon, ledgers, chapter);
  if (criteria.declared && criteria.satisfied) {
    return closeChapter(canon, ledgers, { reason: 'criteria' });
  }

  // Implicit criteria: the chapter paid off everything it planted. Gated on
  // progress so a chapter that resolves one quick thread on its second turn is
  // not cut short.
  const threads = chapterThreads(canon, ledgers, chapter);
  if (threads.resolved && chapterProgress(chapter) >= minProgressForThreads) {
    return closeChapter(canon, ledgers, { reason: 'threads_resolved' });
  }

  if (chapterBudgetExhausted(chapter)) {
    return closeChapter(canon, ledgers, { reason: 'budget' });
  }

  // The extractor noticed the beat resolving; honour it only once the chapter is
  // substantially through, otherwise a single emotional scene ends the chapter.
  if (editorSuggested && chapterProgress(chapter) >= 0.8) {
    return closeChapter(canon, ledgers, { reason: 'editor' });
  }

  return { canon, closed: false, reason: '' };
}
