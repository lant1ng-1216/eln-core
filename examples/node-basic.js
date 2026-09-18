/**
 * ELN Core — Minimal Node.js Example (0.2.0)
 *
 * Run: DEEPSEEK_API_KEY=sk-... node examples/node-basic.js
 *
 * Demonstrates: genre packs, world generation, a streaming turn, the director's
 * beat, information asymmetry via perspective, branching, and persistence —
 * the last of which now works on Node, where there is no `localStorage`.
 */

import { ELNRuntime, genrePack, stylePack, MemoryStorage } from '../index.js';

const eln = new ELNRuntime({
  apiKey: process.env.DEEPSEEK_API_KEY,

  // Genre and style are data, not code. Swap genrePack('xianxia') and the whole
  // voice changes — no prompt code is touched.
  packs: [genrePack('republican'), stylePack('zh-literary')],

  // Cost routing: cheap model for the silent extraction call.
  models: { narrative: 'deepseek-chat', extraction: 'deepseek-chat' },

  // On Node the default is in-memory. Pass a file/Redis adapter for durability.
  storage: new MemoryStorage(),

  onToken: token => process.stdout.write(token),

  onTurnEnd: result => {
    console.log('\n\n── 回合结束 ──');
    console.log('摘要:', result.summary);
    console.log('时空:', `${result.canon.location} / ${result.canon.time}`);
    console.log('张力:', `${result.canon.tension}/100（目标 ${result.beatSpec.tensionTarget}）`);
    if (result.degraded.length) console.log('⚠ 降级字段:', result.degraded.join(', '));
    if (result.secretReveals.length) console.log('秘密透露:', result.secretReveals);
  },

  onEvent: event => {
    if (event.kind === 'intervention') console.log(`\n[导演注入] ${event.summary}`);
  },
});

// 1. Generate a world — the genre pack decides the voice.
console.log('生成世界中...\n');
const world = await eln.generateWorld({ genre: 'republican' });
console.log(`世界：${world.name}（${world.tag}）`);
console.log(`角色：${world.characters.map(c => c.name).join('、')}`);
console.log(`章节：${world.chapters.map(c => c.name).join(' → ')}`);

// 2. Load it.
eln.loadWorld(world);

// 3. Run a few turns.
for (let i = 0; i < 2; i++) {
  console.log(`\n${'─'.repeat(60)}\n第 ${i + 1} 回合\n${'─'.repeat(60)}\n`);
  await eln.runTurn({
    intervention: i === 1 ? '一封没有署名的信被塞进门缝' : '',
  });
}

// 4. Secrets are facts now — query them instead of reading a card field.
const li = eln.getCharacter('李明远');
console.log('\n\n── 秘密是事实，不是角色卡字段 ──');
console.log('李明远的秘密:', eln.getState().canon.facts
  .filter(f => f.subject === li.id && f.tags.includes('secret'))
  .map(f => f.object));

// 5. Perspective: what a given character actually knows.
const xie = eln.getCharacter('谢云舒');
const view = eln.getState({ perspective: xie.id });
console.log(`\n── ${xie.name} 的视角 ──`);
console.log('已知:', view.visibleFacts.map(f => f.object).join('；') || '（无）');
console.log('仍不知晓的秘密数:', view.hiddenFacts.filter(f => f.tags.includes('secret')).length);

// 6. Open foreshadowing threads, most urgent first.
console.log('\n── 未回收的伏笔 ──');
for (const seed of eln.getOpenSeeds()) {
  console.log(`[${seed.urgency.toFixed(2)}] ${seed.text}`);
}

// 7. Branch the world line, then come back.
const branchPoint = eln.getState().canon.version;
eln.branch({ from: branchPoint });
console.log(`\n已从版本 ${branchPoint} 分出新世界线；历史:`,
  eln.history().map(h => `v${h.version}@T${h.turn}`).join(' → '));

// 8. Persist — works on Node.
const worldId = await eln.save('demo-user');
console.log('\n已保存世界:', worldId);
console.log('存档列表:', await eln.listSavedWorlds('demo-user'));
