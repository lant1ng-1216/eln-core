/**
 * ELN Core — Expression / Compose
 *
 * `compose(packs, blocks)` turns data blocks into a prompt string (DESIGN §6).
 * All prompt text for the engine lives here or in the packs — nowhere else.
 * Every world-gen and extraction prompt is built by a function in this file, so
 * "what did we send to the model?" has exactly one answer.
 */

import { genrePack, GENRE_KEYS } from './packs/genres/index.js';
import { stylePack } from './packs/styles/index.js';
import { constraintPack } from './packs/constraints/index.js';
import { PREDICATES, PREDICATE_KEYS, SEED_KINDS } from '../contracts/vocab.js';

/** Used when the caller supplies no genre, so compose() never crashes. */
const NEUTRAL_GENRE = {
  kind: 'genre',
  key: 'neutral',
  name: '叙事',
  worldview: '一个自洽的虚构世界，其规则由世界背景与既有事实决定。',
  tone: '自然、克制、以细节和潜台词推进。',
  tropes: [],
};

/**
 * Accept either `[genrePack, stylePack]` or `{genre, style, constraint}` and
 * return a normalized triple. Unknown/missing kinds fall back to defaults so a
 * partially configured runtime still produces a coherent prompt.
 */
export function normalizePacks(packs = []) {
  const list = Array.isArray(packs) ? packs : Object.values(packs).flat().filter(Boolean);
  const byKind = {};
  for (const p of list) {
    if (p && p.kind) byKind[p.kind] = p;
  }
  return {
    genre: byKind.genre ? genrePack(byKind.genre) : NEUTRAL_GENRE,
    style: stylePack(byKind.style ?? 'zh-literary'),
    constraint: constraintPack(byKind.constraint ?? 'default'),
  };
}

/** Render the hard-format rules, in the style pack's language. */
function renderRules(constraint, style) {
  const d = style.dialogueLabel;
  const m = style.monologueLabel;

  if (style.language === 'en') {
    const rules = [
      `Write at least ${constraint.minWords} words.`,
      'Interleave prose, dialogue and inner monologue. Do not use chapter or 【】 markers in the body.',
      constraint.forbidSeparators ? 'Never use *** or --- as scene separators; use a blank line.' : '',
      constraint.dialoguePerLine
        ? `Dialogue format (one line each, nothing else on the line): Name ${d}: "line"`
        : '',
      constraint.monologueInline
        ? `Inner monologue goes on its own line as (${m}: ...), never inside a prose paragraph.`
        : '',
      'Ground the prose in sensory detail, micro-expressions and body language.',
      constraint.requireHook ? 'End on a hook.' : '',
      constraint.reportSecret
        ? 'If a character chooses to reveal a secret, add a final line: 【秘密透露】From→To: content'
        : '',
      constraint.reportSummary ? 'Make the very last line: 【摘要】one-sentence summary' : '',
    ];
    return rules.filter(Boolean).map((r, i) => `${i + 1}. ${r}`).join('\n');
  }

  const rules = [
    `总字数不少于${constraint.minWords}字`,
    '散文、对话、内心独白自然穿插，不要用任何章节标记或【】标记打断正文',
    constraint.forbidSeparators ? '禁止使用***或---作为场景分隔，场景切换直接用空行过渡' : '',
    constraint.dialoguePerLine
      ? `对话格式严格如下（每行一句，必须单独成行，前后不能有其他文字）：\n   角色名${d}：「对话内容」`
      : '',
    constraint.monologueInline
      ? `内心独白必须紧跟在对应角色对话后，用（${m}：xxx）格式单独一行，禁止嵌入散文段落内`
      : '',
    '散文段落自然分段，写出感官细节（光线、气味、声音）、微表情、肢体动作',
    constraint.requireHook ? '结尾留下悬念钩子' : '',
    constraint.reportSecret
      ? '如有角色因处境或性格决定透露秘密，在文末单独一行写：【秘密透露】角色名→目标名：内容'
      : '',
    constraint.reportSummary ? '最后一行写：【摘要】一句话概括' : '',
    ...(constraint.extra ?? []),
  ];
  return rules.filter(Boolean).map((r, i) => `${i + 1}. ${r}`).join('\n');
}

/**
 * Compose the streaming narrative prompt.
 *
 * @param {Array|Object} packs - genre/style/constraint packs
 * @param {Object<string,string>} blocks - From `assembleContext`
 * @param {{turn: number}} ctx
 * @returns {string}
 */
export function compose(packs, blocks, { turn = 1 } = {}) {
  const { genre, style, constraint } = normalizePacks(packs);

  const tropes = genre.tropes?.length
    ? `\n【可用桥段】${genre.tropes.join('、')}`
    : '';

  const body = [
    blocks.canonBlock,
    blocks.knowledgeBlock,
    blocks.memoryBlock,
    blocks.seedsBlock,
    blocks.beatBlock,
    blocks.interventionBlock,
  ].filter(Boolean).join('\n\n');

  const persona = style.language === 'en'
    ? `You are a master storyteller writing a ${genre.name} novel. This is turn ${turn}.`
    : `你是顶级小说家，正在写一部【${genre.name}】小说。现在写第${turn}回合。`;

  return `${persona}

【题材约束】${genre.worldview}
【文风】${genre.tone}${tropes}
【文风细则】${style.instruction}

${body}

写作要求：
${renderRules(constraint, style)}

只输出小说正文，不要任何额外说明。`;
}

// ── World generation prompt ──────────────────────────────────────────────────

/**
 * Build the world-generation prompt for a genre pack or a free-form description.
 * Genre is injected from the pack, so each template gets its own voice.
 *
 * @param {{genre?: string, prompt?: string, style?: string}} input
 */
export function buildWorldGenPrompt({ genre = null, prompt = null, style = 'zh-literary' } = {}) {
  const styleP = stylePack(style);

  let systemHint;
  if (genre) {
    const g = genrePack(genre);
    systemHint = `请生成一个【${g.name}】类型的叙事世界。\n题材约束：${g.worldview}\n文风基调：${g.tone}`;
  } else {
    systemHint = `请根据用户的描述生成一个叙事世界：${prompt}`;
  }

  const langNote = styleP.language === 'en'
    ? 'All generated content must be written in English.'
    : '所有生成内容使用中文。';

  return `${systemHint}

${langNote}

请生成一个适合多角色AI驱动叙事的完整世界设定，必须返回如下JSON格式，不含任何其他文字：
{
  "name": "世界名称（4-8字，有文学感）",
  "tag": "类型标签（如：古代·权谋）",
  "background": "世界背景描述（100-150字，描述时代、规则、氛围）",
  "outline": "故事大纲（50字，描述主要矛盾和走向）",
  "characters": [
    {"name":"角色名","role":"身份职业","personality":"性格一句话","secret":"最大秘密","goal":"当前目标","weightTag":"男主或女主或男二或女二或反派"},
    {"name":"角色名","role":"身份职业","personality":"性格一句话","secret":"最大秘密","goal":"当前目标","weightTag":"女主或男二"},
    {"name":"角色名","role":"身份职业","personality":"性格一句话","secret":"最大秘密","goal":"当前目标","weightTag":"男二或反派"}
  ],
  "chapters": [
    {"name":"第一章名称","goal":"叙事目标一句话"},
    {"name":"第二章名称","goal":"叙事目标一句话"},
    {"name":"第三章名称","goal":"叙事目标一句话"}
  ]
}`;
}

// ── Extraction prompt ────────────────────────────────────────────────────────

/**
 * Build the silent extraction prompt.
 *
 * Open seed ids are supplied so the model can reference them in
 * `seed_payoffs` — without the list, payoff reporting is impossible.
 *
 * @param {Object} input
 * @param {string} input.narrative
 * @param {import('../contracts/types.js').Canon} input.canon
 * @param {Array} [input.openSeeds]
 */
export function buildExtractionPrompt({ narrative, canon, openSeeds = [] }) {
  const names = canon.entities.filter(e => e.kind === 'character').map(e => e.name).join('，');
  const predicateList = PREDICATES.map(p => `${p.key}（${p.hint}）`).join('；');
  const seedList = openSeeds.length
    ? openSeeds.map(s => `${s.id}：${s.text}`).join('\n')
    : '（当前没有未回收的伏笔）';

  return `根据以下刚刚发生的小说叙事内容，提取状态变化与新增事实。

叙事内容：
${narrative.slice(0, 4000)}

当前角色列表：${names}
当前世界状态：时间${canon.time}，地点${canon.location}，张力${canon.tension}
尚未回收的伏笔（若本回合回收了某条，在 seed_payoffs 中填其 id）：
${seedList}

要求：
- facts 中每条事实的 subject/object 用角色名或已出现的名词。
- predicate 必须从下列受控词表中选一个；若都不合适用 other，并把原文写进 predicate_raw：
${predicateList}
- facts 的 evidence 填叙事中支撑该事实的**原文短句**（便于溯源，不要改写）。
- 只有当叙事中某角色明确知晓/怀疑/误信了 facts 数组中第 i 条事实时，才在 knowledge 中填 {"holderId":"角色名","factIndex":i,"stance":"knows|suspects|believesFalse"}。
- 不要凭空推断角色知道全部真相；不知道就省略。

只返回合法JSON，不含任何其他文字：
{"summary":"一句话摘要","world":{"location":"地点","time":"时间","tension":60},"characters":[{"name":"角色名","emotion":"新情绪词","goal":"目标变化或原目标","alive":true,"trust_changes":{"他人名":5}}],"facts":[{"subject":"角色名","predicate":"secret","predicate_raw":"原文","object":"内容","tags":["secret"],"salience":0.8,"evidence":"支撑该事实的原文短句"}],"events":[{"kind":"action","actors":["角色名"],"location":"地点","time":"时间","summary":"发生了什么"}],"seeds":[{"text":"埋下的伏笔","kind":"${SEED_KINDS.join('|')}","holderIds":["角色名"]}],"seed_payoffs":[{"seedId":"sd_tN_M"}],"knowledge":[{"holderId":"角色名","factIndex":0,"stance":"knows"}],"reveals_secret":[{"from":"名","to":"名","content":"内容"}],"editor":{"chapter_progress":0.6,"suggest_close_chapter":false,"note":"15字内评语"}}`;
}

export { GENRE_KEYS, PREDICATE_KEYS };
