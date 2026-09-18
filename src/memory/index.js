/**
 * ELN Core — Memory barrel.
 *
 * Prose retention, retrieval and persistence. Storage and retrieval are both
 * adapters — the narrative core works without either (DESIGN §2.6).
 */

export * from './adapters/index.js';
export * from './store.js';
export * from './prose.js';
export * from './keywords.js';
export * from './retriever.js';
