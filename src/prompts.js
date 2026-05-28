/**
 * ELN Core — Prompt Builder
 *
 * Builds LLM prompts for world generation and turn execution.
 * All prompt logic is isolated here — swap models or languages
 * without touching the runtime.
 */

// ── Weight tag descriptions ──
const WEIGHT_LABELS = {
  '男主': '[核心主角·每回必有存在感]',
  '女主': '[核心主角·每回必有存在感]',
  '男二': '[重要角色·章节性活跃]',
  '女二': '[重要角色·章节性活跃]',
  '男配': '[次要角色·事件触发]',
  '女配': '[次要角色·事件触发]',
  '反派': '[反派·随张力出场]',
  '隐藏角色': '[隐藏角色·AI择机引入勿强行出场]',
};

// ── Trigger descriptions ──
const TRIGGER_LABELS = {
  alone:   '出场触发：与某角色单独相处时',
  secret:  '出场触发：某秘密面临暴露时',
  tension: '出场触发：故事张力不足时',
  emotion: '出场触发：特定情绪氛围下',
};

/**
 * Build a world-generation prompt.
 *
 * @param {string|null} templateKey  - One of the built-in template keys, or null
 * @param {string|null} userPrompt   - Free-form user description, or null
 * @returns {string} Prompt string ready to send to LLM
 */
export function buildWorldGenPrompt(templateKey, userPrompt) {
  const TEMPLATE_NAMES = {
    ancient:    '古代权谋',
    republican: '民国谍战',
    mystery:    '现代悬疑',
    xianxia:    '架空修仙',
    campus:     '校园青春',
    apocalypse: '末世求生',
  };

  const systemHint = templateKey
    ? `请生成一个【${TEMPLATE_NAMES[templateKey] ?? templateKey}】类型的叙事世界。`
    : `请根据用户的描述生成一个叙事世界：${userPrompt}`;

  return `${systemHint}

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

/**
 * Build a narrative turn prompt (streaming, ~900+ chars of fiction).
 *
 * @param {import('./types.js').WorldState}  worldState
 * @param {import('./types.js').Character[]} characters
 * @param {import('./types.js').Chapter[]}   chapters
 * @param {import('./types.js').TurnRecord[]} recentTurns  - Last N turn records
 * @param {Object} [options]
 * @param {string} [options.intervention]   - God-mode intervention text
 * @param {Object.<string,string>} [options.charDirectives] - Per-character directives
 * @returns {string}
 */
export function buildNarrativePrompt(worldState, characters, chapters, recentTurns = [], options = {}) {
  const { intervention = '', charDirectives = {} } = options;
  const ch = chapters[worldState.currentChapter];

  const charSummaries = characters.map(c => {
    const weightLabel = c.weightTag ? ' ' + (WEIGHT_LABELS[c.weightTag] ?? '') : '';
    const triggerLabel = c.trigger && c.trigger !== 'ai'
      ? '\n' + (TRIGGER_LABELS[c.trigger] ?? '') + '。'
      : '';
    const trustStr = Object.entries(c.trustWith)
      .map(([k, v]) => `${k}:${v}%`)
      .join('，');

    return `【${c.name}】${c.role}${weightLabel}。性格：${c.personality}。情绪：${c.emotion}。目标：${c.goal}。${c.alive ? '' : '（已死亡）'}${triggerLabel}\n秘密：${c.secret}\n信任度：${trustStr}`;
  }).join('\n\n');

  const recentSummary = recentTurns.slice(-3)
    .map(t => `[回合${t.turn}] ${t.summary ?? ''}`)
    .join('\n') || '故事刚刚开始';

  const dirNotes = Object.entries(charDirectives)
    .filter(([, v]) => v)
    .map(([k, v]) => `【${k}本回合专属指令】${v}`)
    .join('\n');

  return `你是顶级华语小说家，正在写一部多线并行的历史谍战小说。现在写第${worldState.turn}回合。

【世界背景】${worldState.background}
【故事大纲】${worldState.outline}
【当前章节：${ch?.name ?? ''}】叙事目标：${ch?.goal ?? ''}
【角色状态】
${charSummaries}
【近期剧情】${recentSummary}
【当前时空】时间：${worldState.time ?? '未定'}，地点：${worldState.location ?? '未定'}，张力：${worldState.tension}/100
${intervention ? `【上帝干预】本回合强制发生：${intervention}` : ''}
${worldState._nextChapterHint ? `【新章节方向】创作者希望本章聚焦：${worldState._nextChapterHint}` : ''}
${dirNotes}

写作要求：
1. 总字数不少于900字
2. 散文、对话、内心独白自然穿插，不要用任何章节标记或【】标记打断正文
3. 禁止使用***或---作为场景分隔，场景切换直接用空行过渡
4. 对话格式严格如下（每行一句，必须单独成行，前后不能有其他文字）：
   角色名道：「对话内容」
5. 说话动词可用：道、说、问、答、低声道、沉声道、冷声道、笑道、喝道、嗤道、哼道等
6. 内心独白必须紧跟在对应角色对话后，用（内心：xxx）格式单独一行，禁止嵌入散文段落内
7. 散文段落自然分段，写出感官细节（光线、气味、声音）、微表情、肢体动作
8. 结尾留下悬念钩子
9. 如有角色因处境或性格决定透露秘密，在文末单独一行写：【秘密透露】角色名→目标名：内容
10. 最后一行写：【摘要】一句话概括

只输出小说正文，不要任何额外说明。`;
}

/**
 * Build a state-update prompt (silent, returns JSON).
 *
 * @param {string}                           narrativeText - Full narrative from last turn
 * @param {import('./types.js').WorldState}  worldState
 * @param {import('./types.js').Character[]} characters
 * @returns {string}
 */
export function buildStateUpdatePrompt(narrativeText, worldState, characters) {
  return `根据以下刚刚发生的小说叙事内容，提取角色状态变化。

叙事内容：
${narrativeText.slice(0, 2000)}

当前角色列表：${characters.map(c => c.name).join('，')}
当前世界状态：时间${worldState.time ?? '未知'}，地点${worldState.location ?? '未知'}，张力${worldState.tension}

只返回合法JSON，不含任何其他文字：
{"characters":[{"name":"角色名","emotion":"新情绪词","goal":"目标变化或原目标","alive":true,"trust_changes":{"他人名":5}}],"world":{"location":"地点","time":"时间","tension":60},"editor":{"chapter_progress":0.6,"suggest_close_chapter":false,"note":"15字内评语"},"summary":"一句话摘要","reveals_secret":[{"from":"名","to":"名","content":"内容"}]}`;
}
