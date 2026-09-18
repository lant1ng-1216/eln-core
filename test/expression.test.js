/**
 * P0 acceptance — expression layer.
 *
 * Two claims under test:
 *  1. Genre is data. Every template gets its own worldview and voice — the
 *     0.1.0 bug where xianxia/campus/apocalypse were all narrated as a
 *     historical spy thriller must not reproduce.
 *  2. `assembleContext` is a pure function whose output can be asserted on.
 *     In particular, a character's context must not contain a secret it does
 *     not know — provable without calling an LLM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GENRE_KEYS, GENRE_PACKS, genrePack } from '../src/expression/packs/genres/index.js';
import { stylePack } from '../src/expression/packs/styles/index.js';
import { compose, normalizePacks, buildWorldGenPrompt, buildExtractionPrompt } from '../src/expression/compose.js';
import { assembleContext } from '../src/expression/render.js';
import { PREDICATE_KEYS } from '../src/contracts/vocab.js';
import { makeState, FIXTURE_WORLD } from './helpers.js';

const packsFor = key => [genrePack(key), stylePack('zh-literary')];

// ── Genre as data ────────────────────────────────────────────────────────────

test('all six built-in templates are registered', () => {
  assert.deepEqual(
    [...GENRE_KEYS].sort(),
    ['ancient', 'apocalypse', 'campus', 'mystery', 'republican', 'xianxia']
  );
  for (const key of GENRE_KEYS) {
    const g = GENRE_PACKS[key];
    assert.equal(g.kind, 'genre');
    assert.ok(g.worldview.length > 20, `${key} needs a real worldview`);
    assert.ok(g.tone.length > 10, `${key} needs a real tone`);
  }
});

test('the 0.1.0 spy-thriller hardcode is gone: no genre is narrated as 谍战', () => {
  const legacyHardcode = '多线并行的历史谍战小说';
  const spyGenres = new Set(['republican', 'ancient']);

  for (const key of GENRE_KEYS) {
    const prompt = compose(packsFor(key), {});

    assert.ok(
      !prompt.includes(legacyHardcode),
      `${key} still contains the removed hardcoded persona`
    );

    if (!spyGenres.has(key)) {
      assert.ok(
        !prompt.includes('谍战'),
        `${key} must not be described as a spy thriller`
      );
    }
  }
});

test('each genre contributes its own worldview, tone and tropes', () => {
  const prompts = new Map(GENRE_KEYS.map(k => [k, compose(packsFor(k), {})]));

  for (const key of GENRE_KEYS) {
    const g = GENRE_PACKS[key];
    const prompt = prompts.get(key);
    assert.ok(prompt.includes(g.name), `${key}: genre name in persona`);
    assert.ok(prompt.includes(g.worldview), `${key}: worldview injected`);
    assert.ok(prompt.includes(g.tone), `${key}: tone injected`);
  }

  // Six distinct prompts — no two genres share a voice.
  assert.equal(new Set(prompts.values()).size, GENRE_KEYS.length);

  // Spot-check the extremes are genuinely different in substance.
  assert.match(prompts.get('xianxia'), /灵气|修真|境界/);
  assert.match(prompts.get('campus'), /校园|学业|社团/);
  assert.match(prompts.get('apocalypse'), /崩塌|废墟|生存/);
  assert.match(prompts.get('republican'), /谍战|租界|势力/);
});

test('compose() throws a helpful error on an unknown genre', () => {
  assert.throws(() => genrePack('steampunk'), /Unknown genre pack "steampunk"/);
});

test('an unknown style falls back rather than crashing, and unknown packs list options', () => {
  assert.throws(() => stylePack('klingon'), /Unknown style pack/);
  // normalizePacks supplies defaults when a pack kind is missing.
  const { genre, style, constraint } = normalizePacks([genrePack('mystery')]);
  assert.equal(genre.key, 'mystery');
  assert.equal(style.key, 'zh-literary');
  assert.equal(constraint.key, 'default');
});

test('style packs drive the dialogue label in the rendered rules', () => {
  const classical = compose([genrePack('ancient'), stylePack('zh-classical')], {});
  const literary = compose([genrePack('ancient'), stylePack('zh-literary')], {});
  const english = compose([genrePack('ancient'), stylePack('en-literary')], {});

  assert.match(literary, /角色名道：/);
  assert.match(classical, /角色名曰：/);
  assert.match(english, /Name says:/);
});

// ── Context assembly / information asymmetry ─────────────────────────────────

test('director mode sees every secret; character mode sees none of the others', () => {
  const state = makeState();

  const director = assembleContext({ canon: state.canon, minds: state.minds, mode: 'director' });
  assert.match(director.knowledgeBlock, /实为地下党联络员/);
  assert.match(director.knowledgeBlock, /替军统传递情报/);
  assert.match(director.canonBlock, /赵鹏/);

  const xieId = state.canon.entities.find(e => e.name === '谢云舒').id;
  const character = assembleContext({
    canon: state.canon, minds: state.minds, mode: 'character', holderId: xieId,
  });

  // 谢云舒 knows her own secret and nobody else's.
  assert.match(character.knowledgeBlock, /替军统传递情报/);
  assert.ok(!character.knowledgeBlock.includes('实为地下党联络员'), 'must not know 李明远’s secret');
  assert.ok(!character.knowledgeBlock.includes('被日谍收买'), 'must not know 赵鹏’s secret');
});

test('a character’s composed prompt leaks no secret it does not know', () => {
  const state = makeState();
  const zhaoId = state.canon.entities.find(e => e.name === '赵鹏').id;

  const blocks = assembleContext({
    canon: state.canon, minds: state.minds, mode: 'character', holderId: zhaoId,
  });
  const prompt = compose(packsFor('republican'), blocks, { turn: 1 });

  assert.ok(!prompt.includes('实为地下党联络员'), '李明远’s secret leaked');
  assert.ok(!prompt.includes('替军统传递情报'), '谢云舒’s secret leaked');
  assert.match(prompt, /被日谍收买/, 'his own secret is legitimately visible');

  // Withheld knowledge is reported as a count, never as content.
  assert.match(blocks.knowledgeBlock, /有 2 件事对你仍是谜团/);
});

test('entity rendering never emits a secret field at all', () => {
  const state = makeState();
  const blocks = assembleContext({ canon: state.canon, minds: state.minds, mode: 'director' });
  // Secrets appear once, in the director's knowledge block — not in the sheets.
  const occurrences = blocks.canonBlock.split('实为地下党联络员').length - 1;
  assert.equal(occurrences, 0, 'the character sheet must not carry secrets');
});

test('the trace records withheld ids without leaking content', () => {
  const state = makeState();
  const xieId = state.canon.entities.find(e => e.name === '谢云舒').id;

  const blocks = assembleContext({
    canon: state.canon, minds: state.minds, mode: 'character', holderId: xieId,
  });

  assert.equal(blocks.trace.mode, 'character');
  assert.equal(blocks.trace.hiddenSecretIds.length, 2);
  assert.ok(blocks.trace.visibleFactIds.includes(
    state.canon.facts.find(f => f.object === '替军统传递情报').id
  ));
});

test('the director’s beat is rendered as a dramatic instruction', () => {
  const state = makeState();
  const beatSpec = {
    mustAdvance: ['e1'],
    mustComplicate: ['巡捕房上门盘查'],
    plantOrPay: ['sd_t0_1'],
    tensionTarget: 62,
    hookKind: '反转',
    constraintNotes: ['本章聚焦：名单的下落'],
  };

  const blocks = assembleContext({ canon: state.canon, minds: state.minds, beatSpec });
  const prompt = compose(packsFor('republican'), blocks, { turn: 2 });

  assert.match(blocks.beatBlock, /必须推进：李明远 的目标/);
  assert.match(blocks.beatBlock, /张力目标：62/);
  assert.match(blocks.beatBlock, /以「反转」收束/);
  assert.match(blocks.beatBlock, /本章聚焦：名单的下落/);
  assert.match(prompt, /本回合戏剧任务/);
});

test('seeds are a director-only artefact', () => {
  const state = makeState();
  state.ledgers.seeds.push({
    id: 'sd_1', plantedTurn: 0, text: '名单藏在教堂', kind: 'item',
    holderIds: [], status: 'open', urgency: 0.5,
  });
  const xieId = state.canon.entities.find(e => e.name === '谢云舒').id;

  const director = assembleContext({ canon: state.canon, minds: state.minds, ledgers: state.ledgers });
  assert.match(director.seedsBlock, /名单藏在教堂/);

  const character = assembleContext({
    canon: state.canon, minds: state.minds, ledgers: state.ledgers,
    mode: 'character', holderId: xieId,
  });
  assert.equal(character.seedsBlock, '', 'a character cannot see the author’s ledger');
});

test('the character budget drops retrieval excerpts before anything else', () => {
  const state = makeState();
  const retrieved = [{ turn: 1, text: '一段很长很长的旧事摘录'.repeat(20) }];

  const loose = assembleContext({ canon: state.canon, minds: state.minds, retrieved });
  assert.match(loose.memoryBlock, /相关旧事/);

  const tight = assembleContext({ canon: state.canon, minds: state.minds, retrieved, budget: 200 });
  assert.ok(!tight.memoryBlock.includes('相关旧事'), 'excerpts are the first thing to go');
  assert.ok(tight.memoryBlock.includes('近期剧情'), 'recent summaries survive');
});

// ── Prompt builders ──────────────────────────────────────────────────────────

test('the world-gen prompt carries genre guidance instead of a fixed genre', () => {
  const xianxia = buildWorldGenPrompt({ genre: 'xianxia' });
  assert.match(xianxia, /架空修仙/);
  assert.ok(!xianxia.includes('谍战'));

  const free = buildWorldGenPrompt({ prompt: '三个AI科学家在火星基地' });
  assert.match(free, /三个AI科学家在火星基地/);
});

test('the extraction prompt publishes the controlled vocabulary and open seed ids', () => {
  const state = makeState();
  const prompt = buildExtractionPrompt({
    narrative: '正文',
    canon: state.canon,
    openSeeds: [{ id: 'sd_t3_1', text: '一封没寄出的信' }],
  });

  for (const key of PREDICATE_KEYS) {
    assert.ok(prompt.includes(key), `predicate "${key}" must be offered to the model`);
  }
  assert.match(prompt, /sd_t3_1：一封没寄出的信/);
  assert.match(prompt, /李明远，谢云舒，赵鹏/);
});

test('a world with no open seeds still produces a valid extraction prompt', () => {
  const state = makeState();
  const prompt = buildExtractionPrompt({ narrative: '正文', canon: state.canon });
  assert.match(prompt, /当前没有未回收的伏笔/);
});

test('fixture world name is threaded through the world-gen prompt', () => {
  const prompt = buildWorldGenPrompt({ genre: 'republican' });
  assert.ok(prompt.includes('民国谍战'));
  assert.ok(prompt.includes(FIXTURE_WORLD.characters[0].name) === false, 'generation precedes the cast');
});
