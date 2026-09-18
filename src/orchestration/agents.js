/**
 * ELN Core — Orchestration / Character agents
 *
 * DESIGN §9 P5: characters act on their own between turns. A character with a
 * goal does not wait to be written — they send a letter, follow someone, bribe a
 * clerk — and that move enters the event ledger with `source: 'agent'`, which
 * the director then reads when planning the next scene.
 *
 * This is where "Agentic" stops being a label on the README. It is deliberately
 * the last phase, because it depends on everything before it: goals (canon),
 * private knowledge (minds), an event ledger to write into, and a director that
 * consumes what lands there.
 *
 * Two layers again:
 *  - **who acts** is deterministic (`pickAgents`) — dead characters and
 *    characters with no goal cannot act, the player is driven by `action`
 *    instead, and rotation keeps it from always being the same two people;
 *  - **what they do** needs a model, because it requires reading the situation.
 *
 * The whole module is optional: without an agent model, `act()` returns nothing
 * and the runtime behaves exactly as it did in P4.
 */

import { EventSchema } from '../contracts/schema.js';

/** Off-screen moves are the loudest thing a character can do to a quiet scene. */
export const AGENT_EVENT_KIND = 'offscreen';

/** Characters without a goal have nothing to pursue. */
const WEIGHT_PRIORITY = {
  '男主': 0, '女主': 0, '反派': 1, '男二': 2, '女二': 2, '男配': 3, '女配': 3, '隐藏角色': 4,
};

/**
 * Choose which characters act off-screen this turn.
 *
 * Deterministic and reproducible. The rotation offset is deliberately different
 * from the director's `mustAdvance` selection so the character carrying a scene
 * is not always the character scheming in the background — if they were the
 * same, the off-screen layer would add nothing.
 *
 * @param {import('../contracts/types.js').Canon} canon
 * @param {number} turn
 * @param {number} [limit]
 * @param {{excludeIds?: string[]}} [options] - Usually the player
 * @returns {string[]} entity ids
 */
export function pickAgents(canon, turn, limit = 2, { excludeIds = [] } = {}) {
  const excluded = new Set(excludeIds);

  const candidates = canon.entities
    .filter(e => e.kind === 'character' && e.alive && e.goal && !excluded.has(e.id))
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
    // +1 keeps the selection out of phase with the director's +0 rotation.
    const offset = (turn + 1) % tier.length;
    ordered.push(...tier.slice(offset), ...tier.slice(0, offset));
  }

  return ordered.slice(0, limit).map(c => c.id);
}

export class CharacterAgents {
  /**
   * @param {object} [options]
   * @param {{complete: Function}} [options.client] - Cheap model
   * @param {string} [options.model]
   * @param {number} [options.maxAgents]
   */
  constructor({ client = null, model = null, maxAgents = 2 } = {}) {
    this.client = client;
    this.model = model;
    this.maxAgents = maxAgents;
  }

  get canAct() {
    return typeof this.client?.complete === 'function';
  }

  /**
   * Ask the selected characters what they do while off-screen.
   *
   * Never throws: a failed or malformed agent call yields no events, and the
   * turn loop continues. Off-screen colour must never cost the player a turn.
   *
   * @param {Object} input
   * @param {import('../contracts/types.js').Canon} input.canon
   * @param {Map<string, import('../contracts/types.js').Mind>} [input.minds]
   * @param {{events: Array, seeds: Array}} [input.ledgers]
   * @param {string} [input.playerEntityId]
   * @returns {Promise<{events: Array, actedIds: string[], modelChecked: boolean, error?: string}>}
   */
  async act({ canon, minds = null, ledgers = { events: [], seeds: [] }, playerEntityId = null }) {
    // `actedIds` means "who actually acted" — with no model, nobody did. The
    // candidate list is not reported as if it were action.
    if (!this.canAct) {
      return { events: [], actedIds: [], modelChecked: false };
    }

    const actedIds = pickAgents(canon, canon.turn, this.maxAgents, {
      excludeIds: playerEntityId ? [playerEntityId] : [],
    });

    if (!actedIds.length) {
      return { events: [], actedIds, modelChecked: false };
    }

    const actors = actedIds
      .map(id => canon.entities.find(e => e.id === id))
      .filter(Boolean);

    const prompt = this._buildPrompt({ canon, ledgers, actors });

    let text;
    try {
      text = await this.client.complete(prompt, { maxTokens: 500, model: this.model ?? undefined });
    } catch (error) {
      return { events: [], actedIds, modelChecked: false, error: String(error?.message ?? error) };
    }

    const proposals = parseProposals(text);
    const events = [];

    for (const proposal of proposals) {
      const actor = actors.find(a => a.name === proposal.name);
      if (!actor) continue;
      if (!proposal.action || !proposal.action.trim()) continue;

      // Reject a move that contradicts canon — an agent does not get to
      // override the world any more than the narrator does.
      if (!actor.alive) continue;

      events.push(EventSchema.parse({
        id: `ev_agent_t${canon.turn}_${events.length + 1}`,
        turn: canon.turn,
        kind: AGENT_EVENT_KIND,
        actors: [actor.id],
        location: canon.location,
        time: canon.time,
        summary: proposal.action.trim(),
        source: 'agent',
      }));
    }

    return { events, actedIds, modelChecked: true };
  }

  _buildPrompt({ canon, ledgers, actors }) {
    const cast = actors
      .map(a => `- ${a.name}（身份：${a.role || '未定'}；目标：${a.goal}；当前情绪：${a.emotion}）`)
      .join('\n');

    const threads = ledgers.seeds
      .filter(s => s.status === 'open')
      .map(s => s.text)
      .join('；') || '（无）';

    const recent = ledgers.events.slice(-5).map(e => e.summary).filter(Boolean).join('\n') || '（无）';

    return `你在为一部${canon.meta.tag || ''}小说设计角色在"幕后"的自主行动。

当前时空：${canon.location}／${canon.time}
未回收的伏笔：${threads}
最近发生的事：
${recent}

请为以下每个角色各设计一个**本场戏之外**的自主行动：
${cast}

要求：
- 行动必须服务于该角色自己的目标，而不是为了推动主角的剧情。
- 必须与既有设定一致，不得凭空引入新地点或新角色。
- 不得直接回收上述伏笔（可以为其铺路或加压）。
- 具体、简短、有画面感（30字内）。

只返回合法JSON，不含其他文字：
{"actions":[{"name":"角色名","action":"他做了什么"}]}`;
  }
}

/** Tolerant parse of the agent payload. */
function parseProposals(text) {
  if (typeof text !== 'string') return [];
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < 0) return [];

  let parsed;
  try {
    parsed = JSON.parse(text.slice(s, e + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.actions)) return [];

  return parsed.actions.filter(
    a => a && typeof a.name === 'string' && typeof a.action === 'string'
  );
}

export function createAgents(options) {
  return new CharacterAgents(options);
}
