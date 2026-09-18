/**
 * ELN Core — Contracts / Validation
 *
 * Two jobs:
 *
 *  1. **State validation** — assert that data the engine owns is well-formed
 *     (`validateCanon`, `validateMind`, ...). Throwing here means "the engine
 *     produced a bug", so these fail loudly.
 *
 *  2. **Extraction validation with block-level degradation** — the LLM payload is
 *     checked one block at a time. A block that fails is *dropped*, not fatal:
 *     the turn still commits with the remaining blocks (DESIGN §9 P0, decision §10.2).
 *
 * Why per-item filtering inside a block: dropping all eight extracted characters
 * because the third one had a bad `trust_changes` value would throw away seven
 * good updates. We keep the good items and report the bad index instead.
 */

import {
  CanonSchema, MindSchema, EventSchema, SeedSchema, ChapterStateSchema,
  ExtractedWorldSchema, ExtractedCharacterSchema, ExtractedFactSchema,
  ExtractedEventSchema, ExtractedSeedSchema, ExtractedSeedPayoffSchema,
  ExtractedKnowledgeSchema, ExtractedRevealSchema, ExtractedEditorSchema,
  GeneratedWorldSchema,
} from './schema.js';

/** Shape a zod error into a compact, loggable string. */
export function formatZodError(error) {
  if (!error?.issues) return String(error?.message ?? error);
  return error.issues
    .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}

/** Throw if `value` does not match `schema`; returns the parsed value. */
export function assertShape(schema, value, label) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`[ELN] Invalid ${label}: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

export const validateCanon      = canon   => assertShape(CanonSchema, canon, 'Canon');
export const validateMind       = mind    => assertShape(MindSchema, mind, 'Mind');
export const validateEvent      = event   => assertShape(EventSchema, event, 'Event');
export const validateSeed       = seed    => assertShape(SeedSchema, seed, 'Seed');
export const validateChapter    = chapter => assertShape(ChapterStateSchema, chapter, 'ChapterState');
export const validateGeneratedWorld = world => assertShape(GeneratedWorldSchema, world, 'GeneratedWorld');

// ── Block-level extraction validation ────────────────────────────────────────

/**
 * @typedef {Object} ValidatedDelta
 * @property {object}  blocks    - Successfully validated blocks (absent = dropped).
 * @property {string[]} degraded - Human-readable notes on what was dropped/trimmed.
 * @property {Object<string,string>} errors - Block name → formatted error message.
 */

/**
 * Validate a single object block. Returns `undefined` + records the error when
 * the block is malformed.
 */
function objectBlock(raw, schema, name, out) {
  if (raw === undefined || raw === null) return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    out.errors[name] = formatZodError(parsed.error);
    out.degraded.push(name);
    return undefined;
  }
  return parsed.data;
}

/**
 * Validate an array block item-by-item, keeping the valid items.
 * The whole block is dropped only when it is not an array at all.
 */
function arrayBlock(raw, itemSchema, name, out) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    out.errors[name] = 'not an array';
    out.degraded.push(name);
    return undefined;
  }
  const kept = [];
  raw.forEach((item, i) => {
    const parsed = itemSchema.safeParse(item);
    if (parsed.success) {
      kept.push(parsed.data);
    } else {
      out.errors[`${name}[${i}]`] = formatZodError(parsed.error);
      out.degraded.push(`${name}[${i}]`);
    }
  });
  return kept;
}

/**
 * Validate an extraction payload block by block.
 *
 * Never throws on malformed model output. The returned `blocks` contains only
 * the parts that parsed; `degraded` lists what was lost so the caller can
 * surface it as `turn.degraded`.
 *
 * Cross-block invariant enforced here: `knowledge[].factIndex` must index into
 * the *validated* `facts` array. If `facts` failed validation, knowledge
 * references cannot be resolved and the knowledge block is dropped wholesale.
 *
 * @param {unknown} raw - Parsed JSON from the extraction call
 * @returns {ValidatedDelta}
 */
export function validateExtraction(raw) {
  const out = { blocks: {}, degraded: [], errors: {} };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    out.errors.root = 'extraction payload is not an object';
    out.degraded.push('root');
    return out;
  }

  // summary is the only field with a safe default; keep the turn useful.
  if (typeof raw.summary === 'string') {
    out.blocks.summary = raw.summary;
  } else {
    out.blocks.summary = '';
    out.errors.summary = 'missing or non-string';
    out.degraded.push('summary');
  }

  const world      = objectBlock(raw.world, ExtractedWorldSchema, 'world', out);
  const editor     = objectBlock(raw.editor, ExtractedEditorSchema, 'editor', out);
  const characters = arrayBlock(raw.characters, ExtractedCharacterSchema, 'characters', out);
  const facts      = arrayBlock(raw.facts, ExtractedFactSchema, 'facts', out);
  const events     = arrayBlock(raw.events, ExtractedEventSchema, 'events', out);
  const seeds      = arrayBlock(raw.seeds, ExtractedSeedSchema, 'seeds', out);
  const payoffs    = arrayBlock(raw.seed_payoffs, ExtractedSeedPayoffSchema, 'seed_payoffs', out);
  const reveals    = arrayBlock(raw.reveals_secret, ExtractedRevealSchema, 'reveals_secret', out);

  if (world)      out.blocks.world = world;
  if (editor)     out.blocks.editor = editor;
  if (characters) out.blocks.characters = characters;
  if (facts)      out.blocks.facts = facts;
  if (events)     out.blocks.events = events;
  if (seeds)      out.blocks.seeds = seeds;
  if (payoffs)    out.blocks.seed_payoffs = payoffs;
  if (reveals)    out.blocks.reveals_secret = reveals;

  // Knowledge depends on facts: resolve indices against the validated array.
  const knowledgeRaw = raw.knowledge;
  if (knowledgeRaw !== undefined && knowledgeRaw !== null) {
    if (!Array.isArray(knowledgeRaw)) {
      out.errors.knowledge = 'not an array';
      out.degraded.push('knowledge');
    } else if (!facts) {
      out.errors.knowledge = 'facts block failed validation; references unresolvable';
      out.degraded.push('knowledge');
    } else {
      const kept = [];
      knowledgeRaw.forEach((item, i) => {
        const parsed = ExtractedKnowledgeSchema.safeParse(item);
        if (!parsed.success) {
          out.errors[`knowledge[${i}]`] = formatZodError(parsed.error);
          out.degraded.push(`knowledge[${i}]`);
          return;
        }
        if (parsed.data.factIndex >= facts.length) {
          out.errors[`knowledge[${i}]`] =
            `factIndex ${parsed.data.factIndex} out of range (0..${facts.length - 1})`;
          out.degraded.push(`knowledge[${i}]`);
          return;
        }
        kept.push(parsed.data);
      });
      out.blocks.knowledge = kept;
    }
  }

  return out;
}

/**
 * Parse a model response into JSON without throwing on fences/preamble.
 * @param {string} text
 * @returns {unknown}
 */
export function parseJSONLoose(text) {
  if (typeof text !== 'string') throw new Error('[ELN] No JSON found in LLM response');
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('[ELN] No JSON found in LLM response');
  return JSON.parse(text.slice(s, e + 1));
}
