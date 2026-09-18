/**
 * ELN Core — Memory / Keyword scoring
 *
 * The default retrieval strategy, chosen so the engine needs no external
 * service and no embedding model. Chinese has no whitespace, so CJK runs are
 * tokenized into character bigrams — a cheap approximation that is good enough
 * for "does this passage still mention the letter from turn 3?".
 *
 * A vector retriever can replace this entirely; see `retriever.js` for the
 * interface it must satisfy.
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN = /[a-z0-9_]/i;

/**
 * Tokenize mixed CJK/latin text.
 * - latin words → lowercased whole words
 * - CJK runs    → character bigrams (plus single characters for 1-char runs)
 *
 * @param {string} text
 * @returns {string[]} unique tokens
 */
export function tokenize(text) {
  if (!text) return [];
  const tokens = new Set();
  let run = '';

  const flush = () => {
    if (!run) return;
    if (run.length === 1) {
      tokens.add(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
    }
    run = '';
  };

  let latin = '';
  const flushLatin = () => {
    if (latin) { tokens.add(latin.toLowerCase()); latin = ''; }
  };

  for (const ch of text) {
    if (CJK.test(ch)) {
      flushLatin();
      run += ch;
    } else if (LATIN.test(ch)) {
      flush();
      latin += ch;
    } else {
      flush();
      flushLatin();
    }
  }
  flush();
  flushLatin();

  return [...tokens];
}

/**
 * Term frequency of `tokens` inside `text`, as a set for O(1) lookup.
 * @returns {Set<string>}
 */
export function tokenSet(text) {
  return new Set(tokenize(text));
}

/**
 * Score a prose record against a query.
 *
 * Two signals, deliberately not blended into something opaque:
 *  - **lexical overlap**, normalised by query length so long queries are not
 *    automatically favoured;
 *  - **entity overlap**, weighted heavily, because "the passage that mentions
 *    these same two people" is almost always the relevant one.
 *
 * @param {import('./prose.js').ProseRecord} record
 * @param {Set<string>} queryTokens
 * @param {{entityIds?: string[]}} [options]
 * @returns {number} score in [0, ~2]
 */
export function scoreRecord(record, queryTokens, { entityIds = [] } = {}) {
  if (!queryTokens.size) return 0;

  const recordTokens = tokenSet(record.text);
  let overlap = 0;
  for (const t of queryTokens) if (recordTokens.has(t)) overlap += 1;
  const lexical = overlap / Math.sqrt(queryTokens.size);

  const wanted = new Set(entityIds);
  const entityHits = record.entityIds.filter(id => wanted.has(id)).length;
  const entityCloseness = entityIds.length
    ? entityHits / entityIds.length
    : 0;

  return lexical + entityCloseness * 1.5;
}
