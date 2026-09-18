#!/usr/bin/env node
/**
 * ELN Core — offline mock provider for `scripts/verify.js`.
 *
 * Emulates an OpenAI-compatible `/chat/completions` endpoint so the verification
 * script's plumbing can be exercised without spending money: argument parsing,
 * scenario flow, the guard's rewrite path, agent adoption, reporting, exit code.
 *
 * It is deliberately *not* a quality test. The prose here is canned, so every
 * [READ] item is meaningless under the mock — the point is only to prove the
 * harness works before you point it at a real model.
 *
 * Usage:
 *   node scripts/mock-server.js            # listens on :8787
 *   node scripts/verify.js --apiKey=mock --apiBase=http://localhost:8787/v1
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8787);

// ── Canned world ─────────────────────────────────────────────────────────────

const WORLD = {
  name: '雾港',
  tag: '民国·谍战',
  background: '一九四三年的上海，各方势力在租界暗处角力。',
  outline: '一份失踪的名单牵动所有人的命运。',
  characters: [
    { name: '李明远', role: '报社主编', personality: '沉稳多疑', secret: '实为地下党联络员', goal: '找到失踪名单', weightTag: '男主' },
    { name: '谢云舒', role: '舞厅老板', personality: '八面玲珑', secret: '替军统传递情报', goal: '保全自身', weightTag: '女主' },
    { name: '赵鹏', role: '巡捕房探长', personality: '贪财怕事', secret: '早已被日谍收买', goal: '捞够钱离开上海', weightTag: '反派' },
  ],
  chapters: [
    { name: '第一章 失踪', goal: '引出名单之谜' },
    { name: '第二章 交锋', goal: '迫使两人正面冲突' },
    { name: '第三章 收网', goal: '揭开名单真相' },
  ],
};

/**
 * Genre-appropriate prose. The mock reads the genre out of the world-gen prompt
 * so the style scenario has something honest to assert on: a spy-thriller line
 * for republican, and something genre-correct for everything else.
 */
const GENRE_PROSE = {
  xianxia: '李明远盘膝而坐，周天灵气缓缓流转，远处剑光如练划破云海。',
  campus: '下课铃响过，李明远抱着课本穿过走廊，操场上传来社团招新的吆喝。',
  apocalypse: '废墟下的水渠里还剩一点积水，李明远撬开铁皮罐，把最后半罐压缩饼干塞进背包。',
  mystery: '李明远把勘验记录摊在桌上，失踪案的时间线出现了一个无法解释的空档。',
  ancient: '李明远跪坐堂下，听着殿上那位衮冕之人缓缓开口，字字如刀。',
  republican: '李明远把烟按灭在碟沿上，低声道：「名单的事，你究竟知道多少？」',
};

function pickGenre(prompt) {
  if (prompt.includes('架空修仙') || prompt.includes('修仙')) return 'xianxia';
  if (prompt.includes('校园')) return 'campus';
  if (prompt.includes('末世')) return 'apocalypse';
  if (prompt.includes('悬疑')) return 'mystery';
  if (prompt.includes('古代权谋')) return 'ancient';
  return 'republican';
}

/** Names the caller's characters, so payloads reference real entities. */
const CAST = ['李明远', '谢云舒', '赵鹏', '林默'];

function extractBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) return '';
  const from = start + startMarker.length;
  const end = endMarker ? text.indexOf(endMarker, from) : -1;
  return (end > from ? text.slice(from, end) : text.slice(from)).trim();
}

// ── Response builders ────────────────────────────────────────────────────────

function buildWorld() {
  return WORLD;
}

/**
 * Read the name out of a rewrite request (`- 赵鹏 已经死亡，却在叙事中说话`),
 * so the mock can honour the correction. Without this the mock would return the
 * identical passage twice and the rewrite loop could never be validated offline.
 */
function correctedName(prompt) {
  const match = prompt.match(/-\s*([^\s，。:：]+)\s*已经死亡/);
  return match ? match[1] : null;
}

function buildNarrative(prompt) {
  const intervention = extractBetween(prompt, '【上帝干预】本回合强制发生：', '\n');
  const isCharacterMode = prompt.includes('【叙事视角】');
  const genre = pickGenre(prompt);

  // A correction request: comply, and keep the offending character off-stage.
  const banned = correctedName(prompt);
  if (banned) {
    return [
      '门被推开，冷风灌进屋里，桌上那盏灯晃了一下。',
      '李明远没有回头，只是把手里的纸条按在掌心。',
      '谢云舒道：「你听见了吗？脚步声在楼下停住了。」',
      `（内心：${banned}的事，绝不能在这里被提起。）`,
      '',
      '【摘要】两人察觉有人在外窥探。',
    ].join('\n');
  }

  // If the intervention names someone, put them on the page — and if the prompt
  // asks for a limited viewpoint while naming a dead character, use dialogue so
  // the continuity guard has something concrete to catch.
  const named = CAST.find(name => intervention.includes(name));

  const scene = [];
  if (named && intervention.includes('推门')) {
    scene.push(`${named}道：「都别动，我有话问。」`);
    scene.push('屋里的人同时僵住，李明远的手指停在茶杯边缘。');
    scene.push('（内心：他怎么会在这里。）');
  } else {
    scene.push(GENRE_PROSE[genre] ?? GENRE_PROSE.republican);
    scene.push('');
    scene.push('谢云舒道：「风声紧，你我都不该在这个时候见面。」');
    scene.push('李明远没有回答，只是把一张纸条推过桌面。');
    scene.push('（内心：名单还在钟楼，可她今天的神色不对。）');
  }

  if (intervention) scene.push(`【备注】${intervention}`);

  if (isCharacterMode) {
    scene.push('（内心：他说的每一句我都记着，但我分不清哪一句是真的。）');
  }

  scene.push('');
  scene.push('【摘要】两人交换了关于名单的线索。');
  return scene.join('\n');
}

function buildExtraction(prompt) {
  const isCharacterMode = prompt.includes('【叙事视角】');

  return {
    summary: '李明远试探谢云舒，两人就名单交换了线索。',
    world: { location: '霞飞路舞厅', time: '深夜', tension: 52 },
    characters: [
      { name: '李明远', emotion: '警觉', goal: '找到失踪名单' },
      { name: '谢云舒', emotion: '戒备', trust_changes: { 李明远: -5 } },
    ],
    facts: [
      {
        subject: '李明远',
        predicate: 'seeks',
        predicate_raw: '寻找',
        object: '失踪名单',
        tags: [],
        salience: 0.9,
        evidence: '名单的事，你究竟知道多少？',
      },
    ],
    events: [
      { kind: 'dialogue', actors: ['李明远', '谢云舒'], summary: '两人就名单交换线索' },
    ],
    seeds: isCharacterMode ? [] : [],
    seed_payoffs: [],
    knowledge: [],
    editor: { chapter_progress: 0.4, suggest_close_chapter: false, note: '节奏偏慢' },
  };
}

function buildAgent(prompt) {
  const named = CAST.filter(name => prompt.includes(name));
  return {
    actions: named.slice(0, 2).map(name => ({
      name,
      action: name === '赵鹏' ? '独自去了码头，见了一个不该见的人' : `在暗中联络旧部，为下一步铺路`,
    })),
  };
}

/**
 * Route on the prompt, exactly like a real model would be *asked* to. The order
 * matters: several prompts mention 角色, so the most specific marker wins.
 */
function respond(body) {
  const prompt = body.messages?.[0]?.content ?? '';

  if (prompt.includes('世界名称')) return buildWorld();
  if (prompt.includes('幕后')) return buildAgent(prompt);
  if (prompt.includes('连续性校对')) return { violations: [] };
  if (prompt.includes('戏剧顾问')) return { complicate: '巡捕房上门盘查', hookKind: '反转' };
  if (prompt.includes('提取状态变化') || prompt.includes('state')) return buildExtraction(prompt);
  return buildExtraction(prompt);
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

function sse(lines) {
  return lines.map(line => `data: ${JSON.stringify({ choices: [{ delta: { content: line } }] })}\n`).join('')
    + 'data: [DONE]\n';
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }

  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end('{"error":{"message":"bad json"}}');
      return;
    }

    const prompt = body.messages?.[0]?.content ?? '';
    process.stdout.write(`  [mock] ${body.stream ? 'stream' : 'complete'} <- ${prompt.slice(0, 48).replace(/\n/g, ' ')}…\n`);

    if (body.stream) {
      const text = buildNarrative(prompt);
      // Emit in small pieces so the SSE parser's carry-over buffer is exercised.
      const pieces = text.match(/[\s\S]{1,7}/g) ?? [];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse(pieces));
      return;
    }

    const payload = JSON.stringify(respond(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: payload } }],
      // Report usage so the cost summary has real numbers to print.
      usage: { prompt_tokens: Math.ceil(prompt.length / 2), completion_tokens: Math.ceil(payload.length / 2) },
    }));
  });
});

server.listen(PORT, () => {
  console.log(`ELN mock provider listening on http://localhost:${PORT}/v1`);
  console.log(`Run:  node scripts/verify.js --apiKey=mock --apiBase=http://localhost:${PORT}/v1`);
});
