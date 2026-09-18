/**
 * ELN Core — public entry point (0.2.0)
 *
 * Open-source Agentic Story World Runtime.
 * https://github.com/lant1ng-1216/eln-core
 *
 * @example
 * import { ELNRuntime, genrePack, stylePack } from '@lant1ng/eln-core'
 *
 * const eln = new ELNRuntime({
 *   apiKey: 'sk-...',
 *   packs: [genrePack('republican'), stylePack('zh-literary')],
 * })
 *
 * const world = await eln.generateWorld({ genre: 'republican' })
 * eln.loadWorld(world)
 * const result = await eln.runTurn()
 */

// Facade
export { ELNRuntime } from './src/runtime.js';

// Transport
export { LLMClient, LLMError, createSSEParser } from './src/transport/llm-client.js';
export {
  UsageTracker, diffUsage, sumUsage, normalizeUsage, estimateTokens,
} from './src/transport/usage.js';

// Contracts — schemas, validation, vocabularies
export {
  PREDICATES, PREDICATE_KEYS, isPredicate,
  ENTITY_KINDS, EVENT_KINDS, EVENT_SOURCES,
  SEED_KINDS, SEED_STATUSES, STANCES, CHAPTER_STATUSES, TEMPLATES,
} from './src/contracts/vocab.js';
export { validateExtraction, validateCanon, parseJSONLoose, formatZodError } from './src/contracts/validate.js';

// State — pure data layer
export {
  canonFromGeneratedWorld, secretsOf, allSecrets, factsAbout,
  entityById, entityByName, resolveRef, currentChapter, makeIdFactory,
} from './src/state/canon.js';
export { createMinds, mindFor, stanceOn, knowsFact, addKnowledge, adjustTrust } from './src/state/mind.js';
export {
  createLedgers, addEvent, addSeed, paySeed, openSeeds, seedsByUrgency,
  computeUrgency, eventsOnTurn, linkCausality,
} from './src/state/ledger.js';
export { VersionStore } from './src/state/version.js';
export { applyDelta } from './src/state/commit.js';
export {
  maybeCloseChapter, closeChapter, evaluateCloseCriteria,
  chapterBudgetExhausted, chapterProgress,
} from './src/state/chapter.js';

// Mind — perspective projection
export { projectCanon, hiddenSecrets, canSee } from './src/mind/project.js';

// Expression — packs, composition, rendering
export {
  genrePack, GENRE_PACKS, GENRE_KEYS,
  stylePack, STYLE_PACKS, STYLE_KEYS,
  constraintPack, CONSTRAINT_PACKS, CONSTRAINT_KEYS,
} from './src/expression/packs/index.js';
export { compose, normalizePacks, buildWorldGenPrompt, buildExtractionPrompt } from './src/expression/compose.js';
export { assembleContext } from './src/expression/render.js';

// Orchestration
export {
  Director, createDirector, tensionTargetFor, HOOK_KINDS,
  PAY_URGENCY_THRESHOLD, ESCALATE_URGENCY, SEED_BUDGET, OVERDUE_AGE,
  TENSION_BAND, TENSION_CURVE,
} from './src/orchestration/director.js';
export { runTurn, TurnFailedError } from './src/orchestration/turn.js';
export { extractWithRepair, buildRepairPrompt, BLOCK_NAMES } from './src/orchestration/repair.js';
export {
  ContinuityGuard, createGuard, checkContinuity,
  extractSpeakers, leakedSecrets, describeViolations,
} from './src/orchestration/guard.js';
export {
  CharacterAgents, createAgents, pickAgents, AGENT_EVENT_KIND,
} from './src/orchestration/agents.js';

// Memory — adapters, prose retention and retrieval
export { MemoryStorage, LocalStorageStorage, createDefaultStorage } from './src/memory/adapters/index.js';
export {
  saveWorld, loadWorld, loadWorlds, deleteWorld,
  serializeState, deserializeState,
} from './src/memory/store.js';
export { ProseStore } from './src/memory/prose.js';
export { tokenize, tokenSet, scoreRecord } from './src/memory/keywords.js';
export { KeywordRetriever, createRetriever, buildQuery } from './src/memory/retriever.js';
