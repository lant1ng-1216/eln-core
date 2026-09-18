/**
 * ELN Core — Controlled Vocabularies
 *
 * Closed sets that the extraction model must map onto. Free-form text is
 * preserved alongside (`predicate_raw`) so nothing is lost when a fact cannot
 * be expressed by the vocabulary.
 *
 * Design decision §10.1: controlled small vocabulary + free-form `tags` + raw text.
 */

/**
 * Controlled predicates for `Fact.predicate`.
 * Each entry: `key` (stored value) and `hint` (used in the extraction prompt).
 */
export const PREDICATES = Object.freeze([
  { key: 'secret',      hint: '某主体隐瞒的身份、行为或事实（object 为秘密内容）' },
  { key: 'identity',    hint: '某主体真实身份/伪装身份（object 为身份描述）' },
  { key: 'goal',        hint: '某主体当前目标或意图' },
  { key: 'is_at',       hint: '某主体所处地点' },
  { key: 'possesses',   hint: '某主体持有某物' },
  { key: 'trusts',      hint: '信任某主体' },
  { key: 'distrusts',   hint: '不信任某主体' },
  { key: 'loves',       hint: '爱慕某主体' },
  { key: 'hates',       hint: '憎恨某主体' },
  { key: 'fears',       hint: '畏惧某主体' },
  { key: 'protects',    hint: '保护某主体' },
  { key: 'betrays',     hint: '背叛某主体' },
  { key: 'allies_with', hint: '与某主体结盟' },
  { key: 'opposes',     hint: '与某主体对立' },
  { key: 'works_for',   hint: '为某主体/组织效力' },
  { key: 'owes',        hint: '欠某主体人情或债务' },
  { key: 'seeks',       hint: '正在追寻某人/某物' },
  { key: 'promise',     hint: '对某主体立下承诺（object 为承诺内容）' },
  { key: 'witnessed',   hint: '目睹了某事件' },
  { key: 'killed',      hint: '杀死了某主体' },
  { key: 'injured',     hint: '伤害了某主体' },
  { key: 'knows_about', hint: '知晓某事（非秘密类的一般信息）' },
  { key: 'other',       hint: '以上都不适用时的兜底（务必同时填 predicate_raw）' },
]);

/** Quick membership set. */
export const PREDICATE_KEYS = Object.freeze(PREDICATES.map(p => p.key));

const PREDICATE_KEY_SET = new Set(PREDICATE_KEYS);

/** @returns {boolean} whether `key` is a known controlled predicate. */
export function isPredicate(key) {
  return PREDICATE_KEY_SET.has(key);
}

/** Entity kinds. */
export const ENTITY_KINDS = Object.freeze(['character', 'place', 'item']);

/** Event kinds (see DESIGN §2.4). */
export const EVENT_KINDS = Object.freeze([
  'action', 'dialogue', 'reveal', 'intervention', 'offscreen', 'world',
]);

/** Who/what caused an event to enter the ledger (see DESIGN §2.4). */
export const EVENT_SOURCES = Object.freeze([
  'narrative', 'player', 'director', 'agent',
]);

/** Seed kinds (see DESIGN §2.5). */
export const SEED_KINDS = Object.freeze([
  'item', 'promise', 'identity', 'prophecy', 'question',
]);

/** Seed lifecycle states. */
export const SEED_STATUSES = Object.freeze(['open', 'paid', 'abandoned']);

/** Stance of a holder towards a fact (see DESIGN §2.3). */
export const STANCES = Object.freeze(['knows', 'suspects', 'believesFalse']);

/** Chapter lifecycle states. */
export const CHAPTER_STATUSES = Object.freeze(['active', 'locked', 'done']);

/** Built-in world templates → genre pack keys. */
export const TEMPLATES = Object.freeze({
  ancient:    'ancient',
  republican: 'republican',
  mystery:    'mystery',
  xianxia:    'xianxia',
  campus:     'campus',
  apocalypse: 'apocalypse',
});
