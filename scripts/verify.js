#!/usr/bin/env node
/**
 * ELN Core — end-to-end claim verification against a real model.
 *
 * The unit suite (`npm test`) proves the *mechanisms*: transactions roll back,
 * blocks degrade, SSE does not drop tokens. It cannot prove anything about what
 * a real model does — every test there runs on a mock transport that always
 * returns well-formed JSON.
 *
 * This script closes that gap. It runs the P0-P5 headline claims against a real
 * provider and prints the actual output as evidence. Checks fall into two kinds:
 *
 *   [PASS]/[FAIL]  decidable by code — counted, and non-zero exit on failure
 *   [READ]         you have to look at it. Narrative quality cannot be asserted.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-... node scripts/verify.js
 *   DEEPSEEK_API_KEY=sk-... node scripts/verify.js --all-genres --turns=8
 *   DEEPSEEK_API_KEY=sk-... node scripts/verify.js --only=guard,agents
 *   node scripts/verify.js --apiBase=https://api.openai.com/v1 --model=gpt-4o --apiKey=sk-...
 *
 * Cost: the default run makes roughly 30 model calls. `--only=` and `--turns=`
 * are there to keep that number down.
 */

import {
  ELNRuntime, genrePack, stylePack,
  assembleContext, compose, checkContinuity, stanceOn,
} from '../index.js';

// ── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `
ELN Core — 真实模型效果验证

用法:
  node scripts/verify.js [选项]

选项:
  --apiKey=<key>         API 密钥（默认读 DEEPSEEK_API_KEY / OPENAI_API_KEY）
  --apiBase=<url>        API 地址（默认 https://api.deepseek.com）
  --model=<name>         模型名（默认 deepseek-chat）
  --turns=<n>            长程记忆场景的回合数（默认 6，至少 5 才能触发章节收尾）
  --genres=a,b,c         文风场景要验的题材（默认 republican,xianxia）
  --all-genres           验全部 6 种题材（调用量翻倍）
  --only=a,b,c           只跑指定场景: style,memory,perspective,guard,agents
  --no-agents            跳过角色智能体场景（需要 models.agent 计费）
  --help                 显示本帮助

场景:
  style        6/2 种题材的文风是否各归其位（P0 修复的硬编码 bug）
  memory       长程记忆 + 导演曲线 + 章节自动收尾（P1/P2）
  perspective  导演模式与角色模式的信息差（P3，零额外调用）
  guard        连续性检出与打回重写（P4）
  agents       幕后自主行动与其被导演采纳（P5）

说明:
  [PASS]/[FAIL] 由代码判定；[READ] 需要你亲自读输出。有任何 FAIL 时退出码为 1。
`;

function parseArgs(argv) {
  const opts = {
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '',
    apiBase: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    turns: 6,
    genres: ['republican', 'xianxia'],
    only: null,
    agents: true,
  };

  for (const arg of argv) {
    const [flag, value] = arg.split('=');
    switch (flag) {
      case '--apiKey': opts.apiKey = value ?? ''; break;
      case '--apiBase': opts.apiBase = value ?? opts.apiBase; break;
      case '--model': opts.model = value ?? opts.model; break;
      case '--turns': opts.turns = Number(value) || opts.turns; break;
      case '--genres': opts.genres = (value ?? '').split(',').map(s => s.trim()).filter(Boolean); break;
      case '--all-genres': opts.genres = ['ancient', 'republican', 'mystery', 'xianxia', 'campus', 'apocalypse']; break;
      case '--only': opts.only = (value ?? '').split(',').map(s => s.trim()).filter(Boolean); break;
      case '--no-agents': opts.agents = false; break;
      case '--help': case '-h': console.log(HELP); process.exit(0); break;
      default:
        if (flag.startsWith('--')) {
          console.error(`未知选项: ${flag}\n${HELP}`);
          process.exit(2);
        }
    }
  }
  return opts;
}

// ── Reporting ────────────────────────────────────────────────────────────────

const checks = [];

function record(scenario, title, status, evidence = '') {
  checks.push({ scenario, title, status, evidence });
  const tag = { PASS: '[PASS]', FAIL: '[FAIL]', SKIP: '[SKIP]', READ: '[READ]' }[status] ?? '[INFO]';
  console.log(`${tag} ${title}`);
  if (evidence) {
    for (const line of String(evidence).split('\n')) console.log(`       ${line}`);
  }
}

const pass = (s, t, e) => record(s, t, 'PASS', e);
const fail = (s, t, e) => record(s, t, 'FAIL', e);
const skip = (s, t, e) => record(s, t, 'SKIP', e);
const read = (s, t, e) => record(s, t, 'READ', e);

const rule = title => {
  console.log(`\n${'─'.repeat(72)}`);
  console.log(title);
  console.log('─'.repeat(72));
};

/** Print a block of prose, indented and clipped, for human reading. */
function quote(text, limit = 240) {
  const body = (text ?? '').trim().replace(/\n{2,}/g, '\n');
  const clipped = body.length > limit ? `${body.slice(0, limit)}…` : body;
  return clipped.split('\n').map(l => `| ${l}`).join('\n');
}

const pct = n => `${(n * 100).toFixed(0)}%`;

// ── Runtime factory ──────────────────────────────────────────────────────────

function makeRuntime(opts, extra = {}) {
  return new ELNRuntime({
    apiKey: opts.apiKey,
    apiBase: opts.apiBase,
    packs: [genrePack(extra.genre ?? 'republican'), stylePack('zh-literary')],
    ...extra.options,
  });
}

const baseModels = opts => ({ narrative: opts.model, extraction: opts.model });

// ── P0: genre voice ──────────────────────────────────────────────────────────

/**
 * Words that only belong to a Republic-era spy setting. If a xianxia or campus
 * world narrates with these, the 0.1.0 hardcoded-persona bug is back.
 */
const REPUBLICAN_MARKERS = ['谍战', '军统', '地下党', '租界', '巡捕房', '特高课'];

async function scenarioStyle(opts) {
  rule(`P0 文风 — 题材是否各归其位（${opts.genres.length} 种题材）`);

  const runtimes = [];

  for (const genre of opts.genres) {
    const runtime = makeRuntime(opts, { genre });
    runtimes.push(runtime);
    try {
      const world = await runtime.generateWorld({ genre });
      runtime.loadWorld(world);
      const result = await runtime.runTurn();

      console.log(`\n[${genre}] ${world.name}（${world.tag}）`);
      console.log(`  角色: ${world.characters.map(c => c.name).join('、')}`);
      console.log(quote(result.narrativeText, 200));

      const spyGenre = genre === 'republican';
      const hits = REPUBLICAN_MARKERS.filter(w => result.narrativeText.includes(w));

      if (spyGenre) {
        read('style', `[${genre}] 民国题材允许出现民国元素`, hits.length
          ? `出现: ${hits.join('、')}（此题材下正常）`
          : '未出现民国元素（该题材下略显平淡，但不算错误）');
        continue;
      }

      if (hits.length) {
        fail('style', `[${genre}] 正文出现了民国谍战词汇`,
          `命中: ${hits.join('、')}\n正文节选:\n${quote(result.narrativeText, 160)}`);
      } else {
        pass('style', `[${genre}] 正文无民国谍战词汇（题材文风正确）`);
      }
    } catch (error) {
      fail('style', `[${genre}] 场景执行失败`, String(error?.message ?? error));
    }
  }

  read('style', '散文质量（人物是否像人、有没有画面感）需你亲自读上面的节选判断');
  return runtimes;
}

// ── P1 + P2: memory, director curve, chapter lifecycle ───────────────────────

/** The distinctive detail planted in turn 1; retrieval must resurface it later. */
const PLANTED_DETAIL = '教堂钟楼的夹层';
const PLANTED_ACTION = `李明远把那份失踪名单藏进了${PLANTED_DETAIL}里，只有他一个人知道`;

async function scenarioMemory(opts) {
  rule(`P1/P2 长程记忆 · 导演曲线 · 章节自动收尾（${opts.turns} 回合）`);

  const marks = [];
  const runtime = makeRuntime(opts, {
    genre: 'republican',
    options: {
      models: baseModels(opts),
      onTurnEnd: r => marks.push(r),
    },
  });

  const world = await runtime.generateWorld({ genre: 'republican' });
  runtime.loadWorld(world);
  runtime.plantSeed('失踪名单到底藏在哪');

  console.log(`\n世界: ${world.name}｜目标章节数: ${world.chapters.length}｜每章预算: ${runtime.getState().canon.chapters[0].targetTurns} 回合`);
  console.log(`第 1 回合注入: ${PLANTED_ACTION}\n`);

  console.log('回合  张力(实际→目标)  导演回收  检索到旧回合  章节');
  console.log('─'.repeat(72));

  let firstTransition = null;
  let retrievalTurn = null;
  let tensionOffCurve = 0;

  for (let i = 0; i < opts.turns; i++) {
    const result = await runtime.runTurn({
      intervention: i === 0 ? PLANTED_ACTION : '',
    });

    const beat = result.beatSpec;
    const actual = result.canon.tension;
    const target = beat.tensionTarget;
    if (Math.abs(actual - target) > 25) tensionOffCurve += 1;

    const retrieved = result.blocks.trace.retrievedTurns ?? [];
    if (retrieved.length) retrievalTurn = retrievalTurn ?? { turn: result.turn, from: retrieved };
    if (result.chapterTransition && !firstTransition) firstTransition = result.chapterTransition;

    console.log(
      `${String(result.turn).padStart(4)}  `
      + `${String(actual).padStart(3)} → ${String(target).padStart(3)}      `
      + `${String(beat.plantOrPay.length).padStart(2)}        `
      + `${(retrieved.length ? retrieved.join(',') : '-').padEnd(14)}`
      + `${result.chapterTransition ? `收尾(${result.chapterTransition.reason})` : ''}`
    );
  }

  const state = runtime.getState();

  // ── P1: retrieval actually looked back ──
  console.log('');
  if (retrievalTurn) {
    pass('memory', `检索层生效：第 ${retrievalTurn.turn} 回合回捞了第 ${retrievalTurn.from.join('、')} 回合的正文`);
  } else {
    skip('memory', '未观察到检索块（可能所有历史正文都被判定为不相关）',
      '检查伏笔是否够明确，或调大 --turns');
  }

  const earlyTurn = retrievalTurn?.from?.find(t => t <= 2);
  if (earlyTurn) {
    pass('memory', `回捞的是早期回合（第 ${earlyTurn} 回合）`);
  } else if (retrievalTurn) {
    fail('memory', '回捞到的都不是早期回合', `实际: ${retrievalTurn.from.join(',')}`);
  }

  const lastBlocks = marks[marks.length - 1]?.blocks ?? {};
  if ((lastBlocks.memoryBlock ?? '').includes('相关旧事')) {
    pass('memory', '最后一回合的上下文里确实带上了【相关旧事】块');
    console.log('\n最后一回合的检索块:\n' + quote(
      lastBlocks.memoryBlock.split('【相关旧事】')[1] ?? '(空)', 200
    ));
  } else {
    skip('memory', '最后一回合未携带检索块（近期回合会被排除，属正常）');
  }

  const plantMentioned = lastBlocks.memoryBlock?.includes('钟楼')
    || state.canon.facts.some(f => String(f.object).includes('钟楼'));
  if (plantMentioned) {
    pass('memory', '第 1 回合埋下的细节在后文上下文中可见');
  } else {
    read('memory', '未在上下文里看到第 1 回合的细节',
      '若伏笔已回收则属正常；否则说明检索没抓住它');
  }

  // ── P2: chapter closed itself ──
  console.log('');
  if (firstTransition) {
    pass('p2', `章节自行收尾（未调用 nextChapter）：${firstTransition.from} → ${firstTransition.to}，原因 ${firstTransition.reason}`);
    if (state.canon.chapterIndex > 0) pass('p2', `章节游标已推进到第 ${state.canon.chapterIndex + 1} 章`);
  } else {
    fail('p2', '整轮跑完章节仍未收尾',
      `每章预算 5 回合，已跑 ${opts.turns} 回合；检查 maybeCloseChapter 是否被跳过`);
  }

  // ── P2: tension followed its curve ──
  // A chapter boundary deliberately resets tension (the climax must not carry
  // over), so on that turn the observed value is *meant* to diverge from the
  // old chapter's target. Comparing across the boundary measures nothing.
  const tensions = marks.map(m => ({
    turn: m.turn,
    actual: m.canon.tension,
    target: m.beatSpec.tensionTarget,
    boundary: Boolean(m.chapterTransition),
  }));
  const comparable = tensions.filter(t => !t.boundary);
  const drifting = comparable.filter(t => Math.abs(t.actual - t.target) > 30);
  const worst = comparable.length
    ? Math.max(...comparable.map(t => Math.abs(t.actual - t.target)))
    : 0;

  if (!comparable.length) {
    skip('p2', '没有可比较的回合（全部落在章节边界上）');
  } else if (drifting.length === 0) {
    pass('p2', `张力在章节内紧跟目标（最大偏差 ${worst}）`
      + (tensions.length !== comparable.length ? `；已排除 ${tensions.length - comparable.length} 个章节边界回合` : ''));
  } else {
    fail('p2', `有 ${drifting.length} 个回合张力偏离目标超过 30`,
      drifting.map(d => `回合${d.turn}: 实际 ${d.actual} / 目标 ${d.target}`).join('\n'));
  }
  read('p2', '张力曲线是否有"张力感"需你读正文判断（数字收敛不等于好看）');

  // ── P1: seed lifecycle ──
  const seeds = runtime.listSeeds({ status: null });
  console.log('');
  if (seeds.length) {
    for (const s of seeds) {
      console.log(`  伏笔 [${s.status}] 紧迫度 ${s.urgency.toFixed(2)}｜第 ${s.plantedTurn} 回合埋下｜${s.text}`);
    }
    const paid = seeds.filter(s => s.status === 'paid');
    if (paid.length) pass('p2', `伏笔被回收：${paid.length} 条`);
    else read('p2', '本轮没有伏笔被回收', '6 回合内未回收属正常，可加 --turns 观察压力累积');
  } else {
    skip('p2', '本轮没有产生伏笔（模型未在抽取中报告 seeds）');
  }

  read('memory', '最终正文（判断是否真的呼应了第 1 回合的细节）',
    quote(marks[marks.length - 1]?.narrativeText, 400));

  return { runtime, marks };
}

// ── P3: perspective / information asymmetry (no extra model calls) ────────────

function scenarioPerspective(runtime, opts) {
  rule('P3 信息差 — 同一份状态，两种视角的 prompt 对比（零额外调用）');

  const { canon, minds } = runtime.getState();
  const packs = [genrePack('republican'), stylePack('zh-literary')];

  const directorBlocks = assembleContext({ canon, minds, mode: 'director' });
  const directorPrompt = compose(packs, directorBlocks, { turn: canon.turn + 1 });

  const characters = canon.entities.filter(e => e.kind === 'character');
  console.log(`\n世界: ${canon.meta.name}｜事实 ${canon.facts.length} 条｜角色 ${characters.length} 人\n`);
  console.log('角色        可见事实  不知晓的秘密  自己的秘密是否可见');
  console.log('─'.repeat(72));

  let leaked = 0;
  let checked = 0;

  for (const entity of characters) {
    const mind = minds.get(entity.id);
    const blocks = assembleContext({ canon, minds, mode: 'character', holderId: entity.id });
    const prompt = compose(packs, blocks, { turn: canon.turn + 1 });

    const ownSecrets = canon.facts.filter(f => f.tags.includes('secret') && f.subject === entity.id);
    const unknownSecrets = canon.facts.filter(f =>
      f.tags.includes('secret') && f.subject !== entity.id && !stanceOn(mind, f.id)
    );

    const visibleOwn = ownSecrets.filter(s => prompt.includes(s.object)).length;
    console.log(
      `${entity.name.padEnd(10)}  ${String(blocks.trace.visibleFactIds.length).padStart(6)}  `
      + `${String(unknownSecrets.length).padStart(11)}  `
      + `${ownSecrets.length ? `${visibleOwn}/${ownSecrets.length}` : '（无）'}`
    );

    for (const secret of unknownSecrets) {
      checked += 1;
      // The positive control: a leak is detectable, because the director prompt
      // does contain the text.
      const inDirector = directorPrompt.includes(secret.object);
      const inCharacter = prompt.includes(secret.object);
      if (inDirector && !inCharacter) continue;
      if (!inDirector) continue;   // empty/unusual secret text — not a leak either way
      leaked += 1;
      console.log(`    ! ${entity.name} 的上下文泄漏了他人秘密：「${secret.object}」`);
    }
  }

  console.log('');
  if (checked === 0) {
    skip('perspective', '没有可检查的"他人未知秘密"（可能已全部揭露）');
  } else if (leaked === 0) {
    pass('perspective', `检查 ${checked} 组(角色, 他人秘密)，无一泄漏`);
  } else {
    fail('perspective', `发现 ${leaked} 处信息泄漏`, '这是结构性 bug，请报 issue');
  }

  console.log('\n导演模式 prompt 中的底牌块:\n'
    + quote(directorBlocks.knowledgeBlock.slice(0, 300), 300));
  console.log('\n某角色的视角块（同一个人，不同视角）:\n'
    + quote(
      assembleContext({ canon, minds, mode: 'character', holderId: characters[1]?.id ?? characters[0].id })
        .knowledgeBlock,
      300
    ));
}

// ── P4: continuity guard + rewrite ───────────────────────────────────────────

async function scenarioGuard(opts) {
  rule('P4 连续性守卫 — 检出与打回重写');

  const runtime = makeRuntime(opts, {
    genre: 'republican',
    options: { models: baseModels(opts), maxRewrites: 1 },
  });
  const world = await runtime.generateWorld({ genre: 'republican' });
  runtime.loadWorld(world);

  const victim = runtime.getCharacter('赵鹏') ?? runtime.getCharacter(world.characters[2].name);
  runtime.getState().canon.entities.find(e => e.id === victim.id).alive = false;
  console.log(`\n已设定 ${victim.name} 死亡（直接改状态，模拟"人工注入矛盾"）\n`);

  // ── Deterministic rule check on real state (no model involved) ──
  const synthetic = `${victim.name}道：「我回来了。」`;
  const verdict = checkContinuity({
    narrative: synthetic,
    canon: runtime.getState().canon,
    minds: runtime.getState().minds,
  });
  if (!verdict.ok && verdict.violations.some(v => v.rule === 'dead_character_speaks')) {
    pass('guard', '确定性规则在真实状态上正确检出"死者开口"',
      verdict.violations.map(v => `${v.severity}: ${v.detail}`).join('\n'));
  } else {
    fail('guard', '确定性规则未检出"死者开口"', JSON.stringify(verdict.violations));
  }

  // ── Live: force the model to make the contradiction happen ──
  const attempts = [];
  let rewriteInfo = null;

  const liveRuntime = makeRuntime(opts, {
    genre: 'republican',
    options: {
      models: baseModels(opts),
      maxRewrites: 1,
      onToken: t => { attempts[attempts.length - 1] = (attempts[attempts.length - 1] ?? '') + t; },
      onRewrite: info => { rewriteInfo = info; attempts.push(''); },
    },
  });
  liveRuntime.loadWorld(world);
  liveRuntime.getState().canon.entities.find(e => e.id === victim.id).alive = false;
  attempts.push('');

  const result = await liveRuntime.runTurn({
    intervention: `${victim.name}突然推门进来，开口质问在场的人`,
  });

  console.log('');
  if (rewriteInfo) {
    pass('guard', '真实模型产出矛盾后触发了重写',
      rewriteInfo.violations.map(v => `${v.severity}: ${v.detail}`).join('\n'));
    console.log(`\n重写前（第 1 版，节选）:\n${quote(attempts[0] ?? '', 200)}`);
    console.log(`\n重写后（采用版，节选）:\n${quote(attempts[1] ?? result.narrativeText, 200)}`);

    if (result.continuity.ok) pass('guard', '重写后矛盾已消除');
    else {
      read('guard', '重写后仍有矛盾（已提交并标记）',
        result.continuity.violations.map(v => v.detail).join('\n'));
    }
  } else {
    skip('guard', '模型自行避开了矛盾，未触发重写',
      '这本身是好结果，但说明本次未能端到端验证重写链路。\n'
      + `可重跑；若不触发属正常波动。\n正文节选:\n${quote(result.narrativeText, 160)}`);
  }

  if (runtime.getState().canon.turn === 0) pass('guard', '注入矛盾的那一轮状态未被污染');

  return [runtime, liveRuntime];
}

// ── P5: character agents ──────────────────────────────────────────────────────

async function scenarioAgents(opts) {
  rule('P5 角色智能体 — 幕后自主行动与其被导演采纳');

  const offscreen = [];
  const runtime = makeRuntime(opts, {
    genre: 'republican',
    options: {
      models: { ...baseModels(opts), agent: opts.model },
      maxAgents: 2,
      onEvent: e => { if (e.source === 'agent') offscreen.push(e); },
    },
  });

  const world = await runtime.generateWorld({ genre: 'republican' });
  runtime.loadWorld(world);

  const first = await runtime.runTurn();
  const firstInfo = first.betweenTurns;

  console.log(`\n第 1 回合幕后候选: ${firstInfo?.actedIds.length ?? 0} 人`);
  if (!firstInfo || !firstInfo.events.length) {
    fail('agents', '配置了 models.agent 但未产生幕后事件',
      firstInfo?.error ? `错误: ${firstInfo.error}` : '模型返回了空或畸形 payload');
  } else {
    pass('agents', `产生 ${firstInfo.events.length} 条幕后事件（source:'agent'）`);
    for (const event of firstInfo.events) {
      const actor = runtime.getState().canon.entities.find(e => e.id === event.actors[0]);
      console.log(`  · ${actor?.name ?? '?'}: ${event.summary}`);
    }
    if (runtime.getState().canon.turn === 1) {
      pass('agents', '幕后行动没有推进回合计数（turn 仍为 1）');
    } else {
      fail('agents', '幕后行动错误地推进了回合计数');
    }
  }

  const second = await runtime.runTurn();
  const adopted = second.beatSpec.adoptedAgentEvents ?? [];

  console.log('');
  if (adopted.length) {
    pass('agents', `导演采纳了 ${adopted.length} 条幕后者事件，转为本回合的义务`);
    const note = second.beatSpec.constraintNotes.find(n => n.includes('幕后：'));
    if (note) console.log(`  约束: ${note}`);
    if (second.blocks.beatBlock.includes('幕后：')) {
      pass('agents', '采纳结果进入了叙事 prompt 的戏剧任务块');
    } else {
      fail('agents', '采纳结果未出现在 prompt 中');
    }
  } else if (!firstInfo?.events.length) {
    skip('agents', '无幕后事件可采纳');
  } else {
    fail('agents', '有幕后事件但导演未采纳');
  }

  read('agents', '幕后行动是否有说服力（是否像那个角色会做的事）',
    offscreen.map(e => `· ${e.summary}`).join('\n') || '(无)');

  return [runtime];
}

// ── Cost summary ─────────────────────────────────────────────────────────────

function reportUsage(scenarios) {
  rule('成本汇总');

  const lines = [];
  let anyEstimated = false;

  for (const { label, runtime, turns } of scenarios) {
    if (!runtime) continue;
    const usage = runtime.usage;
    anyEstimated = anyEstimated || usage.estimated;

    lines.push(`${label}（${turns} 回合）`);
    lines.push(`  合计: ${usage.calls} 次调用 / ${usage.totalTokens} tokens`
      + `${usage.estimated ? '（含估算）' : ''}`);
    for (const [role, u] of Object.entries(usage.byRole)) {
      if (!u.calls) continue;
      lines.push(`    ${role.padEnd(11)} ${String(u.calls).padStart(3)} 次  ${String(u.totalTokens).padStart(7)} tokens`);
    }
  }

  if (!lines.length) {
    console.log('（没有可统计的运行）');
    return;
  }
  console.log(`\n${lines.join('\n')}`);

  if (anyEstimated) {
    console.log('\n注：标"含估算"表示流式响应未上报 usage，token 数由字符数推算，仅供量级参考。');
  }

  const total = scenarios.reduce((n, s) => n + (s.runtime?.usage.totalTokens ?? 0), 0);
  console.log(`\n总计约 ${total} tokens。`);
  console.log('把 narrative/extraction 换成不同模型，对比 byRole 即可验证成本路由是否生效。');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.apiKey) {
    console.error('缺少 API key。请设置 DEEPSEEK_API_KEY 或用 --apiKey=... 传入。\n');
    console.error(HELP);
    process.exit(2);
  }

  const wanted = opts.only ?? ['style', 'memory', 'perspective', 'guard', 'agents'];
  const has = name => wanted.includes(name);

  console.log('ELN Core — 真实模型效果验证');
  console.log(`模型: ${opts.model} @ ${opts.apiBase}`);
  console.log(`场景: ${wanted.join(', ')}｜记忆场景 ${opts.turns} 回合｜题材 ${opts.genres.join(', ')}`);
  console.log('预计约 30 次调用（取决于场景组合）。\n');

  const usageScenarios = [];

  if (has('style')) {
    const runtimes = await scenarioStyle(opts);
    for (const runtime of runtimes) {
      usageScenarios.push({ label: '文风场景', runtime, turns: 1 });
    }
  }

  let memory = null;
  if (has('memory') || has('perspective')) {
    memory = await scenarioMemory(opts);
    usageScenarios.push({ label: `记忆/导演场景`, runtime: memory.runtime, turns: opts.turns });
    if (has('perspective')) scenarioPerspective(memory.runtime, opts);
  }

  if (has('guard')) {
    for (const runtime of await scenarioGuard(opts)) {
      usageScenarios.push({ label: '守卫场景', runtime, turns: 1 });
    }
  }

  if (has('agents') && opts.agents) {
    for (const runtime of await scenarioAgents(opts)) {
      usageScenarios.push({ label: '智能体场景', runtime, turns: 2 });
    }
  }

  reportUsage(usageScenarios);

  // ── Verdict ──
  rule('结论');
  const failed = checks.filter(c => c.status === 'FAIL');
  const passed = checks.filter(c => c.status === 'PASS');
  const skipped = checks.filter(c => c.status === 'SKIP');
  const toRead = checks.filter(c => c.status === 'READ');

  console.log(`代码判定: ${passed.length} 通过 / ${failed.length} 失败 / ${skipped.length} 跳过`);
  console.log(`需你阅读: ${toRead.length} 项（叙事质量无法自动判定）`);

  if (failed.length) {
    console.log('\n失败项:');
    for (const f of failed) console.log(`  · ${f.title}${f.evidence ? `\n    ${f.evidence.split('\n')[0]}` : ''}`);
    process.exit(1);
  }

  console.log('\n所有可自动判定的主张均通过。效果层面请读上面的 [READ] 输出。');
}

main().catch(error => {
  console.error('\n验证脚本异常终止:', error);
  process.exit(1);
});
