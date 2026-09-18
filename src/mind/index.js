/**
 * ELN Core — Mind barrel.
 *
 * Perspective projection lives here and only here (DESIGN §1). Every other
 * layer receives an already-projected `View`.
 */

export * from './project.js';
