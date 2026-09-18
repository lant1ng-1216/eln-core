/**
 * ELN Core — Expression / Rendering
 *
 * Turns state into **plain data blocks** (DESIGN §2.7). Nothing here calls an
 * LLM, which is exactly the point: a test can assert that a character's
 * context does not contain a secret it does not know, without ever making a
 * request. `compose()` later turns the blocks into a string.
 *
 * Information-asymmetry guarantees enforced here:
 *  - Entity rendering never emits a secret (secrets are facts, not card fields).
 *  - Character mode renders only facts the holder holds a stance on.
 *  - Hidden facts contribute an id and tag count, never content.
 */

import { projectCanon, hiddenSecrets } from '../mind/project.js';
import { stanceOn } from '../state/mind.js';
import { currentChapter } from '../state/canon.js';

/** Format a trust map as `名字:62%`. */
function trustLine(canon, mind) {
  if (!mind) return '';
  const parts = Object.entries(mind.trust).map(([id, edge]) => {
    const name = canon.entities.find(e => e.id === id)?.name ?? id;
    return `${name}:${edge.value}%`;
  });
  return parts.join('，');
}

/** One character's public sheet. Secrets are structurally absent. */
function renderEntity(canon, entity, mind) {
  const weight = entity.weightTag ? ` [${entity.weightTag}]` : '';
  const dead = entity.alive ? '' : '（已死亡）';
  const trust = trustLine(canon, mind);
  return [
    `【${entity.name}】${entity.role}${weight}${dead}`,
    `性格：${entity.personality || '未定'}。情绪：${entity.emotion}。目标：${entity.goal || '未定'}`,
    trust ? `信任度：${trust}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * The objective setting plus the visible character sheets.
 * In character mode only the holder's own trust map is usable, so others are
 * rendered without trust values.
 */
function renderCanonBlock(view) {
  const { canon, mind, mode, holderId } = view;
  const chapter = currentChapter(canon);

  const sheets = canon.entities
    .filter(e => e.kind === 'character')
    .map(e => renderEntity(canon, e, mode === 'character' && e.id === holderId ? mind : null));

  const othersWithItems = canon.entities.filter(e => e.kind !== 'character');
  const itemLine = othersWithItems.length
    ? `\n【人物之外】${othersWithItems.map(e => `${e.name}（${e.kind === 'place' ? '地点' : '物件'}）`).join('、')}`
    : '';

  return [
    `【世界背景】${canon.meta.background}`,
    `【故事大纲】${canon.meta.outline}`,
    `【当前章节：${chapter?.name ?? '未命名的章节'}】叙事目标：${chapter?.goal ?? ''}`,
    `【当前时空】时间：${canon.time}，地点：${canon.location}，张力：${canon.tension}/100`,
    `【角色状态】\n${sheets.join('\n\n')}${itemLine}`,
  ].join('\n');
}

/** Facts the holder holds, split by stance so uncertainty is legible. */
function renderKnowledgeBlock(view) {
  if (view.mode === 'director') {
    const secrets = view.canon.facts.filter(f => f.tags.includes('secret'));
    if (!secrets.length) return '';
    const lines = secrets.map(f => {
      const who = view.canon.entities.find(e => e.id === f.subject)?.name ?? f.subject;
      return `- ${who}：${f.object}`;
    });
    return `【客观设定·全部底牌】\n${lines.join('\n')}`;
  }

  const { canon, mind } = view;
  const nameOf = id => canon.entities.find(e => e.id === id)?.name ?? id;
  const fmt = f => {
    const subject = nameOf(f.subject);
    const object = canon.entities.find(e => e.id === f.object)?.name ?? f.object;
    return `- ${subject} / ${f.predicate.replace(/_/g, ' ')} / ${object}`;
  };

  const section = (title, facts) => facts.length
    ? `${title}\n${facts.map(fmt).join('\n')}`
    : '';

  const hidden = hiddenSecrets(view);
  // Placeholder only — never the withheld content.
  const unknownLine = hidden.length
    ? `\n【你尚不知晓】有 ${hidden.length} 件事对你仍是谜团（不得凭空知晓其内容）。`
    : '';

  const known = section('【你确切知道】', view.knownFacts);
  const suspected = section('【你有所怀疑】', view.suspectedFacts);
  const believed = section('【你信以为真】（未必属实）', view.believedFacts);

  const body = [known, suspected, believed].filter(Boolean).join('\n');
  if (!body && !unknownLine) return '';
  return `${body}${unknownLine}`;
}

/**
 * Recent turn summaries plus any retrieved prose (the retriever arrives in P1;
 * P0 accepts a plain array of excerpts).
 */
function renderMemoryBlock(turnRecords, retrieved) {
  const recent = (turnRecords ?? []).slice(-3)
    .map(t => `[回合${t.turn}] ${t.summary ?? ''}`)
    .filter(line => line.trim() !== '[回合undefined] ')
    .join('\n') || '故事刚刚开始';

  const excerpts = (retrieved ?? []).map(r => `[回合${r.turn} 摘录] ${r.text}`).join('\n');

  return [`【近期剧情】${recent}`, excerpts ? `【相关旧事】\n${excerpts}` : '']
    .filter(Boolean).join('\n');
}

/**
 * Point-of-view instruction (DESIGN §3).
 *
 * Director mode narrates omnisciently and emits nothing here. Character mode
 * must *write* from the holder's limited view as well as *filter* to it —
 * without this block the model still has omniscient habits and leaks knowledge
 * through narration even when the facts are withheld.
 */
function renderPovBlock(view) {
  if (view.mode !== 'character' || !view.holder) return '';
  const { name } = view.holder;
  return `【叙事视角】以${name}的有限视角叙述：
- 只呈现${name}能看到、听到、触到、想到的内容。
- 他人的心理活动只能通过外在迹象（表情、语气、动作）暗示，不得直接写出。
- ${name}尚不知晓的事，不得以旁白方式揭晓，也不得让他凭空说出。
- 若${name}的认知有误，就按他的错误认知写，不要替他纠正。`;
}

/** Open threads. Director-only: a character cannot see the author's ledger. */
function renderSeedsBlock(view, ledgers) {
  if (view.mode !== 'director') return '';
  const open = (ledgers?.seeds ?? []).filter(s => s.status === 'open');
  if (!open.length) return '';
  const lines = open
    .sort((a, b) => b.urgency - a.urgency)
    .map(s => `- [${s.id}] (${s.kind}，第${s.plantedTurn}回合埋下，紧迫度${s.urgency.toFixed(2)}) ${s.text}`);
  return `【未回收的伏笔】\n${lines.join('\n')}`;
}

function renderInterventionBlock(intervention, directives) {
  const parts = [];
  if (intervention) parts.push(`【上帝干预】本回合强制发生：${intervention}`);
  for (const [name, text] of Object.entries(directives ?? {})) {
    if (text) parts.push(`【${name}本回合专属指令】${text}`);
  }
  return parts.join('\n');
}

/**
 * The director's dramatic instruction for this turn (DESIGN §4).
 * Unlike 0.1.0's style-only guidance, this says what the turn must *accomplish*.
 */
function renderBeatBlock(beatSpec, canon, ledgers) {
  if (!beatSpec) return '';
  const nameOf = id => canon.entities.find(e => e.id === id)?.name ?? id;
  const seedText = id => ledgers?.seeds?.find(s => s.id === id)?.text ?? id;

  const lines = [];
  if (beatSpec.mustAdvance?.length) {
    lines.push(`- 必须推进：${beatSpec.mustAdvance.map(nameOf).join('、')} 的目标`);
  }
  if (beatSpec.mustComplicate?.length) {
    lines.push(`- 必须制造阻碍：${beatSpec.mustComplicate.join('；')}`);
  }
  if (beatSpec.plantOrPay?.length) {
    // Rendered by text, not id: the model resolves a described thread far more
    // reliably than `sd_t7_2`, even though the id is what the payload references.
    const threads = beatSpec.plantOrPay.map(seedText);
    lines.push(`- 必须回收伏笔：${threads.map(t => `「${t}」`).join('、')}`);
  }
  if (beatSpec.plantCount > 0) {
    lines.push('- 本回合需埋下 1 条新的伏笔（自然融入叙事，不要点破）');
  }
  if (typeof beatSpec.tensionTarget === 'number') {
    lines.push(`- 张力目标：${beatSpec.tensionTarget}/100`);
  }
  if (beatSpec.hookKind) lines.push(`- 收尾方式：以「${beatSpec.hookKind}」收束`);
  for (const note of beatSpec.constraintNotes ?? []) lines.push(`- ${note}`);

  if (!lines.length) return '';
  return `【本回合戏剧任务】\n${lines.join('\n')}`;
}

/**
 * Trim blocks to a character budget. Retrieval excerpts are dropped first
 * (they are the most expendable), then the memory block is truncated.
 * A pluggable trimming strategy is a P1 concern; P0 ships this deterministic one.
 */
function fitBudget(blocks, budget) {
  const limit = typeof budget === 'number' ? budget : budget?.chars;
  if (!limit) return blocks;

  const out = { ...blocks };
  const size = b => Object.values(b).reduce((n, s) => n + (s?.length ?? 0), 0);

  if (size(out) <= limit) return out;

  // 1. Drop retrieved excerpts.
  out.memoryBlock = out.memoryBlock.split('\n【相关旧事】')[0];

  // 2. Truncate the canon block as a last resort.
  if (size(out) > limit) {
    const excess = size(out) - limit;
    if (out.canonBlock.length > excess) {
      out.canonBlock = out.canonBlock.slice(0, out.canonBlock.length - excess) + '…';
    }
  }
  return out;
}

/**
 * Assemble the data blocks for one turn (DESIGN §2.7).
 *
 * @param {Object} input
 * @param {import('../contracts/types.js').Canon} input.canon
 * @param {Map<string, import('../contracts/types.js').Mind>} [input.minds]
 * @param {'director'|'character'} [input.mode]
 * @param {string} [input.holderId]
 * @param {{events: Array, seeds: Array}} [input.ledgers]
 * @param {Array} [input.turnRecords]
 * @param {Array} [input.retrieved]
 * @param {string} [input.intervention]
 * @param {Object<string,string>} [input.directives]
 * @param {number|{chars:number}} [input.budget]
 * @returns {Object<string,string>} blocks
 */
export function assembleContext({
  canon,
  minds = null,
  mode = 'director',
  holderId,
  ledgers = { events: [], seeds: [] },
  turnRecords = [],
  retrieved = [],
  intervention = '',
  directives = {},
  beatSpec = null,
  budget = null,
} = {}) {
  const mind = minds && holderId ? minds.get(holderId) ?? null : null;
  const view = projectCanon(canon, mind, mode, holderId);

  const blocks = {
    canonBlock: renderCanonBlock(view),
    knowledgeBlock: renderKnowledgeBlock(view),
    povBlock: renderPovBlock(view),
    memoryBlock: renderMemoryBlock(turnRecords, retrieved),
    seedsBlock: renderSeedsBlock(view, ledgers),
    beatBlock: renderBeatBlock(beatSpec, canon, ledgers),
    interventionBlock: renderInterventionBlock(intervention, directives),
  };

  const fitted = fitBudget(blocks, budget);

  // Trace is metadata for tests/observability. Ids and counts only — never content.
  fitted.trace = {
    mode: view.mode,
    holderId: view.holderId ?? null,
    visibleFactIds: view.visibleFacts.map(f => f.id),
    hiddenFactIds: view.hiddenFacts.map(f => f.id),
    hiddenSecretIds: hiddenSecrets(view).map(f => f.id),
    /** Which past turns retrieval resurfaced — lets a caller verify "it looked back". */
    retrievedTurns: (retrieved ?? []).map(r => r.turn),
  };

  return fitted;
}

export { projectCanon, stanceOn };
