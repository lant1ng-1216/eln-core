/**
 * ELN Core — Expression barrel.
 *
 * Data → string only. Everything here is snapshot-testable without an LLM
 * (DESIGN §1 layer rules).
 */

export * from './compose.js';
export * from './render.js';
export * from './packs/genres/index.js';
export * from './packs/styles/index.js';
export * from './packs/constraints/index.js';
