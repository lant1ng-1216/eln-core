/**
 * ELN Core — Orchestration / Director
 *
 * Answers "what must this turn accomplish?" (DESIGN §4). 0.1.0 handed the model
 * style instructions ("at least 900 words", "end on a hook"); the director hands
 * it *dramatic* ones ("advance A's goal, pay off the letter planted in turn 7,
 * close on a reversal").
 *
 * Split deliberately in two:
 *
 *  - `plan()` is **sync and deterministic**. The tension curve, seed due dates,
 *    who must advance, and the chapter budget are all computed from state. No
 *    model is consulted, so a beat is reproducible and snapshot-testable.
 *  - `enrich()` is **async and optional**. Only the parts that need semantic
 *    judgement — what obstacle to introduce, whether the hook should be a
 *    reversal — are asked of a cheap model. Without a director model the
 *    deterministic beat stands on its own.
 */

import { seedsByUrgency, openSeeds } from '../state/ledger.js';
import { currentChapter } from '../state/canon.js';

/** Public headline for the turn's closing beat. */
export const HOOK_KINDS = Object.freeze(['悬念', '信息', '情感', '反转']);

/** Protagonists are asked to advance more often than supporting cast. */
const WEIGHT_PRIORITY = {
  '男主': 0, '女主': 0, '男二': 1, '女二': 1, '反派': 2, '男配': 3, '女配': 3, '隐藏角色': 4,
};

/** A seed at or above this urgency must be paid this turn. */
export const PAY_URGENCY_THRESHOLD = 0.4;

/** A seed at or above this urgency is overdue and escalates to a hard note. */
export const ESCALATE_URGENCY = 0.75;

/** Beyond this age an open seed is treated as overdue regardless of mentions. */
export const OVERDUE_AGE = 10;

/** Keep at most this many threads open before planting more. */
export const SEED_BUDGET = 3;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @typedef {Object} BeatSpec
 * @property {string[]} mustAdvance     - Entity ids whose goals must move
 * @property {string[]} mustComplicate  - Obstacles that must be introduced
 * @property {string[]} plantOrPay      - Seed ids that must be resolved now
 * @property {number} plantCount        - How many new threads to plant (0 or 1)
 * @property {string[]} overdue         - Seeds past the escalation threshold
 * @property {number} tensionTarget     - Intent value for this turn
 * @property {string} hookKind
 * @property {string[]} constraintNotes
 * @property {string} [playerAction]    - The reviewed action folded into this beat
 * @property {string[]} [adoptedAgentEvents] - Off-screen events this beat must honour
 * @property {boolean} [enriched]       - Whether a model contributed to this beat
 */

/** The tension the chapter is aiming for at its current progress. */
function curveTarget(chapter) {
  if (!chapter) return 40;
  const progress = chapter.targetTurns > 0
    ? Math.min(1, chapter.completedTurns / chapter.targetTurns)
    : 0;
  return 25 + progress * 45; // rises 25 → 70 across the chapter
}

/**
 * Error-corrected target (decision §10.3, "差驱动").
 *
 * Canon's tension is the *observed* value; this is the *intent*. When the prose
 * has been running colder than the curve, the target is pushed up (and vice
 * versa), so the actual value converges on the curve instead of the curve
 * drifting away from the story.
 */
export function tensionTargetFor(canon, chapter) {
  const curve = curveTarget(chapter);
  const error = curve - canon.tension;
  return Math.round(clamp(curve + clamp(error * 0.5, -15, 15), 5, 95));
}

/**
 * Deterministically choose which characters must advance this turn.
 *
 * Selection is tiered by narrative weight, and the rotation happens *within* a
 * tier rather than across the whole cast. Rotating globally would let a minor
 * character outrank a protagonist on some turns, which defeats the point of
 * having a weight tag at all.
 */
function pickMustAdvance(canon, turn, limit = 2) {
  const candidates = canon.entities
    .filter(e => e.kind === 'character' && e.alive && e.goal)
    .sort((a, b) => {
      const pa = WEIGHT_PRIORITY[a.weightTag] ?? 3;
      const pb = WEIGHT_PRIORITY[b.weightTag] ?? 3;
      return pa - pb || a.id.localeCompare(b.id);
    });

  if (!candidates.length) return [];

  const tiers = new Map();
  for (const c of candidates) {
    const p = WEIGHT_PRIORITY[c.weightTag] ?? 3;
    if (!tiers.has(p)) tiers.set(p, []);
    tiers.get(p).push(c);
  }

  const ordered = [];
  for (const priority of [...tiers.keys()].sort((a, b) => a - b)) {
    const tier = tiers.get(priority);
    const offset = turn % tier.length;
    ordered.push(...tier.slice(offset), ...tier.slice(0, offset));
  }

  return ordered.slice(0, limit).map(c => c.id);
}

/**
 * Decide which threads must be resolved now, and whether to plant a new one.
 *
 * A seed becomes due as it ages, as it keeps being mentioned, and as the chapter
 * closes — all computed in `state/ledger.js`. This function is the consumer that
 * 0.1.0 never had: tension and seeds existed but nobody acted on them.
 */
function planSeeds(ledgers, canon) {
  const open = openSeeds(ledgers);
  const chapter = currentChapter(canon);

  const ranked = seedsByUrgency(ledgers);
  const due = ranked.filter(s => s.urgency >= PAY_URGENCY_THRESHOLD);
  const overdue = due.filter(s =>
    s.urgency >= ESCALATE_URGENCY || canon.turn - s.plantedTurn >= OVERDUE_AGE
  );

  const plantOrPay = due.map(s => s.id);

  // Plant only when the ledger is not already crowded, and thin it out as the
  // chapter closes so the ending is not buried under new promises.
  const closing = chapter ? chapter.completedTurns / chapter.targetTurns : 0;
  const budget = closing >= 0.8 ? 1 : SEED_BUDGET;
  const plantCount = open.length < budget ? 1 : 0;

  return { plantOrPay, overdue: overdue.map(s => s.id), plantCount };
}

export class Director {
  /**
   * @param {object} [options]
   * @param {number} [options.maxSeedsPerTurn] - Cap on threads paid per turn
   * @param {number} [options.maxAdvance] - Cap on characters asked to advance
   * @param {{complete: Function}} [options.client] - Cheap model for `enrich()`
   * @param {string} [options.model]
   */
  constructor({ maxSeedsPerTurn = 2, maxAdvance = 2, client = null, model = null } = {}) {
    this.maxSeedsPerTurn = maxSeedsPerTurn;
    this.maxAdvance = maxAdvance;
    this.client = client;
    this.model = model;
  }

  /**
   * Plan one beat. Deterministic: the same state always yields the same beat.
   *
   * @param {Object} input
   * @param {import('../contracts/types.js').Canon} input.canon
   * @param {{events: Array, seeds: Array}} [input.ledgers]
   * @param {'director'|'character'} [input.mode]
   * @param {string} [input.holderId] - The player, in character mode
   * @param {string} [input.action]   - The player's declared action, already reviewed
   * @returns {BeatSpec}
   */
  plan({
    canon,
    ledgers = { events: [], seeds: [] },
    mode = 'director',
    holderId = null,
    action = '',
  }) {
    const chapter = currentChapter(canon);
    const turn = canon.turn + 1; // the turn about to be written

    const { plantOrPay, overdue, plantCount } = planSeeds(ledgers, canon);

    const constraintNotes = [];
    for (const seedId of overdue) {
      const seed = ledgers.seeds.find(s => s.id === seedId);
      if (seed) {
        constraintNotes.push(
          `伏笔「${seed.text}」已积压 ${turn - seed.plantedTurn} 回合，本回合必须给出交代（回收或明确转折）`
        );
      }
    }

    // ── Adopt off-screen character action (DESIGN §9 P5) ──
    // An agent event is only worth writing if a scene picks it up; otherwise the
    // ledger accumulates moves nobody ever sees. Recent ones become obligations.
    const adoptedAgentEvents = [];
    for (const event of (ledgers.events ?? []).filter(
      e => e.source === 'agent' && turn - e.turn <= 1
    ).slice(-2)) {
      const actor = canon.entities.find(e => e.id === event.actors?.[0]);
      adoptedAgentEvents.push(event.id);
      constraintNotes.push(
        `幕后：${actor?.name ?? '某人'}${event.summary}。本回合必须让此事的影响渗入场景（不必直写，但不能当作没发生过）`
      );
    }

    let mustAdvance = pickMustAdvance(canon, turn, this.maxAdvance);

    if (mode === 'character' && holderId) {
      const holder = canon.entities.find(e => e.id === holderId);
      if (holder) {
        // The player is always on stage. Their own thread leads the beat, and
        // the declared action becomes an obligation rather than a suggestion
        // (decision §10.4: the action is routed through the director, which
        // folds it into the same beat the rest of the scene obeys).
        mustAdvance = [holderId, ...mustAdvance.filter(id => id !== holderId)]
          .slice(0, this.maxAdvance);

        constraintNotes.push(`必须给 ${holder.name} 留出行动与反应的余地`);
        if (action) {
          constraintNotes.push(
            `玩家本回合的行动：${action}。必须让它在叙事中产生可见后果，不得无视或拖延`
          );
        }
      }
    }

    return {
      mustAdvance,
      mustComplicate: [],
      plantOrPay: plantOrPay.slice(0, this.maxSeedsPerTurn),
      plantCount,
      overdue,
      tensionTarget: tensionTargetFor(canon, chapter),
      hookKind: HOOK_KINDS[turn % HOOK_KINDS.length],
      constraintNotes,
      playerAction: action || '',
      adoptedAgentEvents,
    };
  }

  /**
   * Review a player action against the hard constraints of canon
   * (decision §10.4: accept by default, intervene only on a canon violation).
   *
   * A violation is *reported*, not silently rewritten. Quietly changing what the
   * player said they did is worse than refusing: it is indistinguishable from a
   * bug, and the caller cannot tell why the world ignored them.
   *
   * @param {string} action
   * @param {{canon: object, playerEntityId: string}} context
   * @returns {{allowed: boolean, action: string, reason: string}}
   */
  reviewAction(action, { canon, playerEntityId }) {
    const text = (action ?? '').trim();
    if (!text) return { allowed: true, action: '', reason: '' };

    const player = canon.entities.find(e => e.id === playerEntityId);
    if (!player) {
      return { allowed: false, action: text, reason: `玩家角色 ${playerEntityId} 不存在于当前世界` };
    }
    if (!player.alive) {
      return { allowed: false, action: text, reason: `${player.name} 已死亡，无法行动` };
    }

    const deadMentioned = canon.entities.filter(
      e => e.kind === 'character' && !e.alive && e.name && text.includes(e.name)
    );
    if (deadMentioned.length) {
      return {
        allowed: false,
        action: text,
        reason: `行动涉及已死亡的角色：${deadMentioned.map(e => e.name).join('、')}`,
      };
    }

    return { allowed: true, action: text, reason: '' };
  }

  /** True when a model is available to contribute semantic judgement. */
  get canEnrich() {
    return typeof this.client?.complete === 'function';
  }

  /**
   * Ask a cheap model for the parts a rule cannot decide: what obstacle to
   * introduce, and whether the hook kind should change.
   *
   * Never throws and never blocks a turn — any failure returns the
   * deterministic beat unchanged.
   *
   * @param {BeatSpec} beatSpec
   * @param {{canon: object, ledgers: object, mode?: string, holderId?: string}} context
   * @returns {Promise<BeatSpec>}
   */
  async enrich(beatSpec, { canon, ledgers = { events: [], seeds: [] } }) {
    if (!this.canEnrich) return beatSpec;

    const chapter = currentChapter(canon);
    const cast = canon.entities
      .filter(e => e.kind === 'character')
      .map(e => `${e.name}（目标：${e.goal || '未定'}）`)
      .join('；');
    const threads = openSeeds(ledgers).map(s => s.text).join('；') || '（无）';

    const prompt = `你是一部${canon.meta.tag || ''}小说的戏剧顾问。为下一回合设计一个障碍和一个收尾钩子。

当前章节：${chapter?.name ?? ''}（目标：${chapter?.goal ?? ''}）
角色：${cast}
当前张力：${canon.tension}/100，本回合目标张力：${beatSpec.tensionTarget}
未回收伏笔：${threads}
本回合必须推进：${beatSpec.mustAdvance.length ? '见角色设定' : '无特定要求'}

只返回合法JSON，不含其他文字：
{"complicate":"本回合必须制造的一个具体阻碍（20字内，须与上述人物或伏笔直接相关）","hookKind":"${HOOK_KINDS.join('|')}"}`;

    try {
      const text = await this.client.complete(prompt, { maxTokens: 200, model: this.model ?? undefined });
      const json = parseLooseJSON(text);
      if (!json) return beatSpec;

      const complicate = typeof json.complicate === 'string' && json.complicate.trim()
        ? [json.complicate.trim()]
        : [];

      return {
        ...beatSpec,
        mustComplicate: complicate,
        hookKind: HOOK_KINDS.includes(json.hookKind) ? json.hookKind : beatSpec.hookKind,
        enriched: true,
      };
    } catch {
      // A director advisory is never load-bearing.
      return beatSpec;
    }
  }
}

/** Tolerant JSON extraction — the advisor may wrap output in prose. */
function parseLooseJSON(text) {
  if (typeof text !== 'string') return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}

export function createDirector(options) {
  return new Director(options);
}

export function planBeat(director, input) {
  return (director ?? new Director()).plan(input);
}
