/**
 * ELN Core — State / Canon
 *
 * Canon is the objective truth of the world (DESIGN §2.2). It is pure data:
 * no IO, no fetch, no narrative semantics. Every function here is either a
 * constructor or a total query over plain objects.
 */

import { CanonSchema, ChapterStateSchema } from '../contracts/schema.js';
import { validateCanon } from '../contracts/validate.js';

/** Deterministic 32-bit string hash — used for reproducible initial trust. */
export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Sequential id factory. Ids embed the turn so they stay unique across a
 * versioned history without a global counter (which would break branching).
 *
 * @param {number} turn
 * @returns {(prefix: string) => string}
 */
export function makeIdFactory(turn) {
  let n = 0;
  return prefix => `${prefix}_t${turn}_${++n}`;
}

/** Find an entity by its id. @returns {import('../contracts/types.js').Entity|undefined} */
export function entityById(canon, id) {
  return canon.entities.find(e => e.id === id);
}

/** Find an entity by exact name. @returns {import('../contracts/types.js').Entity|undefined} */
export function entityByName(canon, name) {
  return canon.entities.find(e => e.name === name);
}

/** Human-readable name for an entity id, falling back to the raw value. */
export function displayName(canon, idOrName) {
  const e = entityById(canon, idOrName);
  return e ? e.name : idOrName;
}

/**
 * Resolve a name-or-id produced by the model into an EntityId when possible.
 * Unresolvable references are kept verbatim so no information is lost.
 */
export function resolveRef(canon, idOrName) {
  if (!idOrName) return idOrName;
  if (entityById(canon, idOrName)) return idOrName;
  const byName = entityByName(canon, idOrName);
  return byName ? byName.id : idOrName;
}

/**
 * Secrets are facts tagged `secret` (DESIGN §2.3) — not a string on the
 * character card. This is the query that replaces `character.secret`.
 *
 * @returns {import('../contracts/types.js').Fact[]}
 */
export function secretsOf(canon, entityId) {
  return canon.facts.filter(f => f.subject === entityId && f.tags.includes('secret'));
}

/** All secrets in the world, regardless of holder. */
export function allSecrets(canon) {
  return canon.facts.filter(f => f.tags.includes('secret'));
}

/** Facts whose subject is `entityId`. */
export function factsAbout(canon, entityId) {
  return canon.facts.filter(f => f.subject === entityId || f.object === entityId);
}

/** The chapter currently being narrated. */
export function currentChapter(canon) {
  return canon.chapters[canon.chapterIndex];
}

/**
 * Build a fresh Canon from a world-generation payload.
 *
 * Secrets from the generated characters become `secret` facts owned by their
 * character entity, so downstream code never needs `character.secret`.
 *
 * @param {object} generated - Validated GeneratedWorld
 * @param {number} [now]
 * @returns {import('../contracts/types.js').Canon}
 */
export function canonFromGeneratedWorld(generated, now = Date.now()) {
  const entities = [];
  const facts = [];
  const idf = makeIdFactory(0);

  generated.characters.forEach((c, i) => {
    const id = `e${i + 1}`;
    entities.push({
      id,
      kind: 'character',
      name: c.name,
      role: c.role ?? '',
      personality: c.personality ?? '',
      goal: c.goal ?? '',
      alive: true,
      emotion: '平静',
      weightTag: c.weightTag,
      tags: [],
    });

    if (c.secret) {
      facts.push({
        id: idf('f'),
        subject: id,
        predicate: 'secret',
        predicate_raw: 'secret',
        object: c.secret,
        turn: 0,
        salience: 1,
        tags: ['secret'],
      });
    }
  });

  const chapters = generated.chapters.map((ch, idx) =>
    ChapterStateSchema.parse({
      index: idx,
      name: ch.name,
      goal: ch.goal ?? '',
      targetTurns: 5,
      completedTurns: 0,
      status: idx === 0 ? 'active' : 'locked',
    })
  );

  return CanonSchema.parse({
    id: `w_${now}`,
    version: 0,
    meta: {
      name: generated.name,
      tag: generated.tag ?? '',
      background: generated.background ?? '',
      outline: generated.outline ?? '',
      createdAt: now,
    },
    time: '未定',
    location: '未定',
    tension: 30,
    entities,
    facts,
    chapters,
    chapterIndex: 0,
    turn: 0,
  });
}

/** Assert a canon is well-formed. Throws with a readable message otherwise. */
export function assertCanon(canon) {
  return validateCanon(canon);
}

/** Deep structural clone. Canon is JSON-safe by construction. */
export function cloneCanon(canon) {
  return structuredClone(canon);
}
