/**
 * ELN Core — Orchestration / Continuity guard
 *
 * DESIGN §9 P4: check the prose for contradictions and send it back for one
 * rewrite when it breaks canon.
 *
 * The load-bearing part is **deterministic**. "A dead character speaks", "a
 * character-mode scene states a secret the viewpoint character does not know"
 * and "an invented name is given dialogue" are all decidable from state, so they
 * need no model and are reproducible in tests. A cheap model can add a semantic
 * pass on top (`models.critic`), but its absence degrades quality, never
 * correctness.
 *
 * Violations carry a severity. Only `error` triggers a rewrite; `warn` and
 * `info` are surfaced for observability. Rewriting prose is expensive and
 * visible to the caller, so the bar for spending one is deliberately high.
 */

import { stanceOn } from '../state/mind.js';
import { tokenize } from '../memory/keywords.js';

/**
 * @typedef {Object} Violation
 * @property {string} rule
 * @property {'info'|'warn'|'error'} severity
 * @property {string} detail
 */

/**
 * Dialogue attribution, tolerant of the style packs' speech verbs
 * (`道` / `曰` / `说` / `says`), their modifiers (`低声道`) and the space an
 * English style puts between the name and the verb (`Name says:`).
 *
 * This is a heuristic, not a parser. A prose line that happens to end in
 * `道：` can be misread as dialogue — which is why rule 1 only fires when the
 * captured name is a *known* character, and rule 2 is non-blocking.
 */
const SPEAKER = /^([^\s，。：:「」『』]{1,12}?)\s*(?:低声|沉声|冷声|轻声|高声|笑|喝|嗤|哼|叹)?(?:道|曰|说|问|答|says)\s*[:：]/;

/** Lines that are structural trailers, not prose. */
const TRAILER = /^【(摘要|秘密透露|本回合|.*任务|.*伏笔)】/;

/**
 * Fraction of a phrase's tokens that appear in `text`.
 * Bigram-based (see `memory/keywords.js`) — robust to the paraphrase that real
 * prose applies, where a verbatim substring test fails.
 */
function tokenCoverage(phrase, text) {
  const wanted = tokenize(phrase);
  if (wanted.length < 3) return text.includes(phrase) ? 1 : 0;
  const present = new Set(tokenize(text));
  const hits = wanted.filter(t => present.has(t)).length;
  return hits / wanted.length;
}

/** Coverage at or above this counts as having stated the secret. */
const LEAK_COVERAGE = 0.6;

/**
 * Extract dialogue attributions from the narrative.
 * @returns {Array<{name: string, line: string}>}
 */
export function extractSpeakers(narrative) {
  const out = [];
  for (const raw of narrative.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('（') || TRAILER.test(line)) continue;
    const match = SPEAKER.exec(line);
    if (match) out.push({ name: match[1], line });
  }
  return out;
}

/** Facts a character mode viewpoint must not have stated (DESIGN §3). */
export function leakedSecrets(canon, minds, holderId, narrative) {
  const mind = minds?.get?.(holderId);
  if (!mind) return [];

  return canon.facts.filter(fact => {
    if (!fact.tags.includes('secret')) return false;
    if (stanceOn(mind, fact.id)) return false;      // the holder may know it
    if (fact.subject === holderId) return false;    // its own secret
    if (!fact.object) return false;
    return tokenCoverage(fact.object, narrative) >= LEAK_COVERAGE;
  });
}

/**
 * Deterministic continuity rules.
 *
 * @param {Object} input
 * @param {string} input.narrative
 * @param {import('../contracts/types.js').Canon} input.canon
 * @param {Map<string, import('../contracts/types.js').Mind>} [input.minds]
 * @param {'director'|'character'} [input.mode]
 * @param {string} [input.holderId]
 * @returns {{ok: boolean, violations: Violation[]}}
 */
export function checkContinuity({ narrative, canon, minds = null, mode = 'director', holderId = null }) {
  const violations = [];
  if (typeof narrative !== 'string' || !narrative.trim()) {
    return { ok: true, violations };
  }

  const byName = new Map(
    canon.entities.filter(e => e.name).map(e => [e.name, e])
  );

  // ── Rule 1: the dead do not speak ──
  for (const { name } of extractSpeakers(narrative)) {
    const entity = byName.get(name);
    if (!entity) continue; // handled by rule 2
    if (!entity.alive) {
      violations.push({
        rule: 'dead_character_speaks',
        severity: 'error',
        detail: `${name} 已经死亡，却在叙事中说话`,
      });
    }
  }

  // ── Rule 2: dialogue belongs to someone the world knows ──
  const knownNames = new Set(byName.keys());
  const invented = new Set();
  for (const { name } of extractSpeakers(narrative)) {
    if (!knownNames.has(name)) invented.add(name);
  }
  for (const name of invented) {
    violations.push({
      rule: 'unknown_speaker',
      severity: 'info',
      detail: `叙事中出现未登记的发声者「${name}」（若是路人可忽略）`,
    });
  }

  // ── Rule 3: a limited viewpoint must not narrate what it cannot know ──
  if (mode === 'character' && holderId) {
    if (!canon.entities.some(e => e.id === holderId)) {
      violations.push({
        rule: 'unknown_holder',
        severity: 'error',
        detail: `视角角色 ${holderId} 不存在于当前世界`,
      });
    }
    for (const fact of leakedSecrets(canon, minds, holderId, narrative)) {
      const holder = canon.entities.find(e => e.id === fact.subject);
      violations.push({
        rule: 'secret_leak',
        severity: 'error',
        detail: `视角角色无从知晓的秘密被写出：「${fact.object}」（属于 ${holder?.name ?? fact.subject}）`,
      });
    }
  }

  return { ok: !violations.some(v => v.severity === 'error'), violations };
}

/** Turn a violation list into instructions for a rewrite. */
export function describeViolations(violations) {
  return violations
    .filter(v => v.severity === 'error')
    .map(v => `- ${v.detail}`)
    .join('\n');
}

export class ContinuityGuard {
  /**
   * @param {object} [options]
   * @param {{complete: Function}} [options.client] - Optional critic model
   * @param {string} [options.model]
   */
  constructor({ client = null, model = null } = {}) {
    this.client = client;
    this.model = model;
  }

  get canUseModel() {
    return typeof this.client?.complete === 'function';
  }

  /** Deterministic check. Always available, never fails. */
  check(input) {
    return checkContinuity(input);
  }

  /**
   * Deterministic check, plus a semantic pass when a critic model is wired up.
   * The model can only *add* violations; it can never clear a deterministic one.
   *
   * @returns {Promise<{ok: boolean, violations: Violation[], modelChecked: boolean}>}
   */
  async review(input) {
    const base = this.check(input);
    if (!this.canUseModel) return { ...base, modelChecked: false };

    try {
      const extra = await this._askModel(input);
      const violations = [...base.violations, ...extra];
      return {
        ok: !violations.some(v => v.severity === 'error'),
        violations,
        modelChecked: true,
      };
    } catch {
      return { ...base, modelChecked: false };
    }
  }

  async _askModel({ narrative, canon, ledgers, mode, holderId }) {
    const cast = canon.entities
      .filter(e => e.kind === 'character')
      .map(e => `${e.name}${e.alive ? '' : '（已死亡）'}`)
      .join('、');

    const prompt = `你是小说连续性校对。检查下面这段正文是否与既定设定矛盾。

角色：${cast}
当前地点：${canon.location}；时间：${canon.time}
视角：${mode === 'character' ? `仅限 ${canon.entities.find(e => e.id === holderId)?.name ?? holderId} 可感知的范围` : '全知'}

正文：
${narrative.slice(0, 3000)}

只返回合法JSON，不含其他文字。没有矛盾就返回空数组：
{"violations":[{"severity":"error|warn","detail":"具体矛盾（25字内）"}]}`;

    const text = await this.client.complete(prompt, { maxTokens: 300, model: this.model ?? undefined });
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e < 0) return [];

    let parsed;
    try {
      parsed = JSON.parse(text.slice(s, e + 1));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed.violations)) return [];

    return parsed.violations
      .filter(v => v && typeof v.detail === 'string' && v.detail.trim())
      .map(v => ({
        rule: 'critic',
        severity: v.severity === 'error' ? 'error' : 'warn',
        detail: v.detail.trim(),
      }));
  }
}

export function createGuard(options) {
  return new ContinuityGuard(options);
}
