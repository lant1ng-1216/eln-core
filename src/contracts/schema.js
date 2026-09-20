/**
 * ELN Core — Contracts / Schemas
 *
 * zod definitions for every persisted data structure (DESIGN §2) and for the
 * extraction payload (DESIGN §5.1 step 4).
 *
 * Two families live here:
 *
 *  - **State schemas** (`Canon`, `Mind`, `Event`, `Seed`, ...) describe data the
 *    engine owns. They are strict: if the engine writes them, they must be valid.
 *  - **Extraction schemas** (`Extracted*`) describe what the LLM returns. They are
 *    deliberately lenient (coercion, defaults, `.catch()`) because models are
 *    unreliable; the caller validates block-by-block and degrades (DESIGN §9 P0).
 */

import { z } from 'zod';
import {
  PREDICATE_KEYS, ENTITY_KINDS, EVENT_KINDS, EVENT_SOURCES,
  SEED_KINDS, SEED_STATUSES, STANCES, CHAPTER_STATUSES,
} from './vocab.js';

// ── Primitives ───────────────────────────────────────────────────────────────

/** Entity / fact / event / seed identifiers are opaque strings. */
export const IdSchema = z.string().min(1);

/** A unit of narrative weight, clamped to [0, 1]. */
export const SalienceSchema = z.number().min(0).max(1);

// ── Canon (DESIGN §2.2) ──────────────────────────────────────────────────────

export const EntitySchema = z.object({
  id: IdSchema,
  kind: z.enum(ENTITY_KINDS),
  name: z.string(),
  role: z.string().default(''),
  personality: z.string().default(''),
  goal: z.string().default(''),
  alive: z.boolean().default(true),
  emotion: z.string().default('平静'),
  weightTag: z.string().optional(),
  trigger: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export const FactSchema = z.object({
  id: IdSchema,
  /** EntityId when resolvable, otherwise the raw name the model produced. */
  subject: z.string(),
  /** Controlled predicate, or `'other'` with `predicate_raw` carrying the text. */
  predicate: z.enum(PREDICATE_KEYS),
  /** Original free-form predicate text; always kept (decision §10.1). */
  predicate_raw: z.string().default(''),
  object: z.string(),
  turn: z.number().int().nonnegative(),
  salience: SalienceSchema.default(0.5),
  tags: z.array(z.string()).default([]),
  /**
   * Provenance (DESIGN §9 P1 "抽取溯源"): which turn produced this fact and the
   * sentence it came from. Without it a fact is an assertion with no way back
   * to the prose that justifies it.
   */
  evidence: z.object({
    turn: z.number().int().nonnegative(),
    quote: z.string().default(''),
  }).optional(),
});

export const BeatSchema = z.object({
  turn: z.number().int().nonnegative(),
  /** Director intent for this beat (filled by the director layer in P2). */
  intent: z.string().default(''),
  tensionTarget: z.number().min(0).max(100).optional(),
  done: z.boolean().default(true),
});

export const CloseCriteriaSchema = z.object({
  seedsToPay: z.array(IdSchema).default([]),
  goalsToMeet: z.array(z.string()).default([]),
});

export const ChapterStateSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  goal: z.string().default(''),
  targetTurns: z.number().int().positive().default(5),
  completedTurns: z.number().int().nonnegative().default(0),
  status: z.enum(CHAPTER_STATUSES).default('locked'),
  /**
   * The turn this chapter began on. Needed to answer "which threads belong to
   * this chapter?" — a chapter that resolves the seeds it planted can close on
   * that basis rather than only on its turn budget.
   *
   * Defaults to 0, not 1: anything planted before the first turn (author setup,
   * a seed declared at load time) belongs to the opening chapter.
   */
  startedTurn: z.number().int().nonnegative().default(0),
  beats: z.array(BeatSchema).default([]),
  closeCriteria: CloseCriteriaSchema.default({}),
});

/**
 * NOTE: DESIGN §2.2 sketches `chapter: ChapterState` (singular). A world carries
 * several chapters, so canon stores the list plus the cursor instead. See
 * CHANGELOG 0.2.0 "设计偏离说明".
 */
export const CanonSchema = z.object({
  id: IdSchema,
  version: z.number().int().nonnegative().default(0),
  meta: z.object({
    name: z.string(),
    tag: z.string().default(''),
    background: z.string().default(''),
    outline: z.string().default(''),
    createdAt: z.number().int().nonnegative(),
  }),
  time: z.string().default('未定'),
  location: z.string().default('未定'),
  /** Observed tension (actual value). The director holds the intent value. */
  tension: z.number().min(0).max(100).default(30),
  entities: z.array(EntitySchema).default([]),
  facts: z.array(FactSchema).default([]),
  chapters: z.array(ChapterStateSchema).default([]),
  chapterIndex: z.number().int().nonnegative().default(0),
  turn: z.number().int().nonnegative().default(0),
});

// ── Mind (DESIGN §2.3) ───────────────────────────────────────────────────────

export const FactRefSchema = z.object({
  factId: IdSchema,
  confidence: z.number().min(0).max(1).optional(),
  since: z.number().int().nonnegative().optional(),
  evidence: z.array(z.number().int().nonnegative()).optional(),
});

export const TrustEdgeSchema = z.object({
  value: z.number().min(0).max(100),
  evidence: z.array(z.number().int().nonnegative()).default([]),
});

export const MindSchema = z.object({
  holderId: IdSchema,
  knows: z.array(FactRefSchema).default([]),
  suspects: z.array(FactRefSchema).default([]),
  believesFalse: z.array(FactRefSchema).default([]),
  trust: z.record(z.string(), TrustEdgeSchema).default({}),
});

// ── Ledgers (DESIGN §2.4, §2.5) ──────────────────────────────────────────────

export const EventSchema = z.object({
  id: IdSchema,
  turn: z.number().int().nonnegative(),
  kind: z.enum(EVENT_KINDS),
  actors: z.array(IdSchema).default([]),
  location: z.string().default(''),
  time: z.string().default(''),
  summary: z.string().default(''),
  causes: z.array(IdSchema).default([]),
  effects: z.array(IdSchema).default([]),
  source: z.enum(EVENT_SOURCES).default('narrative'),
});

export const SeedSchema = z.object({
  id: IdSchema,
  plantedTurn: z.number().int().nonnegative(),
  text: z.string(),
  kind: z.enum(SEED_KINDS).default('question'),
  holderIds: z.array(IdSchema).default([]),
  status: z.enum(SEED_STATUSES).default('open'),
  payoffTurn: z.number().int().nonnegative().optional(),
  payoffEventId: IdSchema.optional(),
  urgency: z.number().min(0).max(1).default(0),
});

// ── Extraction payload (lenient) ─────────────────────────────────────────────
//
// Every block is validated independently. See `validate.js` for the
// block-by-block degradation strategy (decision §10.2).

const Lenient = {
  str: () => z.coerce.string(),
  num: () => z.coerce.number(),
  bool: () => z.boolean().catch(true),
  strArray: () => z.array(z.coerce.string()).catch([]),
};

export const ExtractedWorldSchema = z.object({
  location: z.string().optional(),
  time: z.string().optional(),
  tension: z.coerce.number().min(0).max(100).optional(),
});

export const ExtractedCharacterSchema = z.object({
  name: z.string(),
  emotion: z.string().optional(),
  goal: z.string().optional(),
  alive: z.boolean().optional(),
  trust_changes: z.record(z.string(), z.coerce.number()).optional(),
});

export const ExtractedFactSchema = z.object({
  subject: z.string(),
  predicate: z.enum(PREDICATE_KEYS).catch('other'),
  predicate_raw: z.string().optional(),
  object: z.string(),
  tags: Lenient.strArray(),
  salience: z.coerce.number().min(0).max(1).catch(0.5),
  /** A short verbatim quote supporting the fact (optional; aids traceability). */
  evidence: z.string().optional(),
});

export const ExtractedEventSchema = z.object({
  kind: z.enum(EVENT_KINDS).catch('action'),
  actors: Lenient.strArray(),
  location: z.string().optional(),
  time: z.string().optional(),
  summary: z.string(),
});

export const ExtractedSeedSchema = z.object({
  text: z.string(),
  kind: z.enum(SEED_KINDS).catch('question'),
  holderIds: Lenient.strArray(),
});

export const ExtractedSeedPayoffSchema = z.object({
  seedId: z.string(),
});

/**
 * `factIndex` refers to the position of a fact inside the *same* extraction
 * response's `facts` array. Referencing a fact by index (rather than by a
 * model-invented id) keeps the payload resolvable without a second round trip
 * (decision §10.2: single extraction).
 */
export const ExtractedKnowledgeSchema = z.object({
  holderId: z.string(),
  factIndex: z.coerce.number().int().nonnegative(),
  stance: z.enum(STANCES).catch('knows'),
});

export const ExtractedRevealSchema = z.object({
  from: z.string(),
  to: z.string(),
  content: z.string().optional(),
});

export const ExtractedEditorSchema = z.object({
  chapter_progress: z.coerce.number().min(0).max(1).optional(),
  suggest_close_chapter: z.boolean().optional(),
  note: z.string().optional(),
});

/** The full extraction shape, for documentation and prompt generation. */
export const ExtractionSchema = z.object({
  summary: z.string(),
  world: ExtractedWorldSchema.optional(),
  characters: z.array(ExtractedCharacterSchema).optional(),
  facts: z.array(ExtractedFactSchema).optional(),
  events: z.array(ExtractedEventSchema).optional(),
  seeds: z.array(ExtractedSeedSchema).optional(),
  seed_payoffs: z.array(ExtractedSeedPayoffSchema).optional(),
  knowledge: z.array(ExtractedKnowledgeSchema).optional(),
  reveals_secret: z.array(ExtractedRevealSchema).optional(),
  editor: ExtractedEditorSchema.optional(),
});

// ── World generation payload (lenient) ───────────────────────────────────────

export const GeneratedCharacterSchema = z.object({
  name: z.string(),
  role: z.string().catch(''),
  personality: z.string().catch(''),
  secret: z.string().catch(''),
  goal: z.string().catch(''),
  weightTag: z.string().optional(),
});

export const GeneratedChapterSchema = z.object({
  name: z.string(),
  goal: z.string().catch(''),
});

export const GeneratedWorldSchema = z.object({
  name: z.string(),
  tag: z.string().catch(''),
  background: z.string().catch(''),
  outline: z.string().catch(''),
  characters: z.array(GeneratedCharacterSchema).min(1),
  chapters: z.array(GeneratedChapterSchema).min(1),
});
