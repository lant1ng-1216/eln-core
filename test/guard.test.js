/**
 * P4 acceptance — continuity guard, rewrite and cost observability.
 *
 * DESIGN §9 P4: an injected contradiction must be caught and sent back for a
 * rewrite, and a single turn's cost must be readable. The guard is deterministic
 * first — a critic model can only add findings, never clear one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ELNRuntime } from '../src/runtime.js';
import {
  ContinuityGuard, checkContinuity, extractSpeakers, describeViolations,
} from '../src/orchestration/guard.js';
import { UsageTracker, diffUsage, sumUsage, normalizeUsage, estimateTokens } from '../src/transport/usage.js';
import { MemoryStorage } from '../src/memory/adapters/memory-storage.js';
import { genrePack } from '../src/expression/packs/genres/index.js';
import { stylePack } from '../src/expression/packs/styles/index.js';
import { FIXTURE_WORLD, sampleExtraction, sseResponse, sseChunks, jsonResponse } from './helpers.js';

const completionResponse = (payload, usage) => jsonResponse({
  choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }],
  ...(usage ? { usage } : {}),
});

function makeRuntime({ fetchOpts = {}, runtimeOpts = {}, storage = new MemoryStorage() } = {}) {
  let streamCalls = 0;
  const handler = async (url, init) => {
    const body = JSON.parse(init.body);
    fetchOpts.onBody?.(body);

    if (body.stream) {
      const script = fetchOpts.narratives ?? [fetchOpts.narrative ?? '平淡的一回合。'];
      const text = script[Math.min(streamCalls, script.length - 1)];
      streamCalls += 1;
      return sseResponse(sseChunks([text]));
    }

    const prompt = body.messages[0].content;
    if (prompt.includes('世界名称')) return completionResponse(FIXTURE_WORLD);
    if (prompt.includes('连续性校对')) {
      return completionResponse(fetchOpts.critic ?? { violations: [] });
    }
    if (prompt.includes('戏剧顾问')) return completionResponse(fetchOpts.director ?? {});
    return completionResponse(fetchOpts.extraction ?? sampleExtraction(), fetchOpts.usage);
  };

  const runtime = new ELNRuntime({
    apiKey: 'test-key',
    apiBase: 'https://example.invalid',
    packs: [genrePack('republican'), stylePack('zh-literary')],
    storage,
    fetchImpl: handler,
    ...runtimeOpts,
  });
  return { runtime, storage };
}

const loadWorld = async runtime => {
  runtime.loadWorld(await runtime.generateWorld({ genre: 'republican' }));
};

const kill = (runtime, name) => {
  const entity = runtime.getState().canon.entities.find(e => e.name === name);
  entity.alive = false;
  return entity;
};

// ── Speaker extraction ───────────────────────────────────────────────────────

test('dialogue attribution is parsed across speech verbs and modifiers', () => {
  const narrative = [
    '李明远道：「名单在哪？」',
    '谢云舒低声道：「我不知道。」',
    '赵鹏冷声道：「都别动。」',
    '林默曰：「且慢。」',
    'Someone says: "stop"',
    '（内心：她在撒谎。）',
    '【摘要】两人对峙',
  ].join('\n');

  assert.deepEqual(
    extractSpeakers(narrative).map(s => s.name),
    ['李明远', '谢云舒', '赵鹏', '林默', 'Someone']
  );
});

test('inner monologue and trailer lines are never read as dialogue', () => {
  const narrative = [
    '（内心：他说得不对。）',
    '【秘密透露】李明远→谢云舒：内容',
    '【摘要】两人对峙',
  ].join('\n');
  assert.deepEqual(extractSpeakers(narrative), []);
});

// ── Deterministic rules ──────────────────────────────────────────────────────

test('a dead character speaking is an error', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const zhao = kill(runtime, '赵鹏');

  const result = checkContinuity({
    narrative: '赵鹏道：「谁在那儿？」\n谢云舒没有回答。',
    canon: runtime.getState().canon,
    minds: runtime.getState().minds,
  });

  assert.equal(result.ok, false);
  const violation = result.violations.find(v => v.rule === 'dead_character_speaks');
  assert.ok(violation);
  assert.equal(violation.severity, 'error');
  assert.match(violation.detail, /赵鹏 已经死亡/);
  assert.equal(zhao.alive, false);
});

test('a living cast speaking is clean', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  const result = checkContinuity({
    narrative: '李明远道：「名单在哪？」\n谢云舒笑道：「你猜。」',
    canon: runtime.getState().canon,
    minds: runtime.getState().minds,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('an unregistered speaker is reported but does not block the turn', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);

  const result = checkContinuity({
    narrative: '跑堂道：「二位要点什么？」',
    canon: runtime.getState().canon,
    minds: runtime.getState().minds,
  });

  assert.equal(result.ok, true, 'a walk-on part must not force a rewrite');
  const violation = result.violations.find(v => v.rule === 'unknown_speaker');
  assert.equal(violation.severity, 'info');
});

test('a limited viewpoint narrating an unknown secret is an error', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const xie = runtime.getCharacter('谢云舒');

  const result = checkContinuity({
    narrative: '谢云舒看着他，心里明白他就是地下党联络员。',
    canon: runtime.getState().canon,
    minds: runtime.getState().minds,
    mode: 'character',
    holderId: xie.id,
  });

  assert.equal(result.ok, false);
  const violation = result.violations.find(v => v.rule === 'secret_leak');
  assert.match(violation.detail, /实为地下党联络员/);
});

test('the same sentence is fine in director mode, and fine if the holder knows', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const xie = runtime.getCharacter('谢云舒');
  const narrative = '谢云舒看着他，心里明白他就是地下党联络员。';

  // Omniscient narrator: allowed.
  assert.equal(checkContinuity({
    narrative, canon: runtime.getState().canon, minds: runtime.getState().minds, mode: 'director',
  }).ok, true);

  // Reveal it to her first, then it is allowed in her viewpoint too.
  runtime.forceSecretReveal('李明远', '谢云舒');
  assert.equal(checkContinuity({
    narrative,
    canon: runtime.getState().canon,
    minds: runtime.getState().minds,
    mode: 'character',
    holderId: xie.id,
  }).ok, true);
});

test('a character’s own secret is never a leak in their own viewpoint', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  const xie = runtime.getCharacter('谢云舒');

  const result = checkContinuity({
    narrative: '谢云舒想起自己替军统传递情报的那些夜晚。',
    canon: runtime.getState().canon,
    minds: runtime.getState().minds,
    mode: 'character',
    holderId: xie.id,
  });

  assert.equal(result.ok, true);
});

test('an empty or non-string narrative is never a violation', () => {
  const canon = { entities: [] };
  assert.equal(checkContinuity({ narrative: '', canon }).ok, true);
  assert.equal(checkContinuity({ narrative: null, canon }).ok, true);
});

test('describeViolations lists only the blocking errors', () => {
  const text = describeViolations([
    { rule: 'x', severity: 'error', detail: '严重问题' },
    { rule: 'y', severity: 'info', detail: '无关紧要' },
  ]);
  assert.match(text, /严重问题/);
  assert.ok(!text.includes('无关紧要'));
});

// ── Critic model ─────────────────────────────────────────────────────────────

test('without a critic model the guard is purely deterministic', async () => {
  const guard = new ContinuityGuard();
  assert.equal(guard.canUseModel, false);

  const review = await guard.review({ narrative: '李明远道：「好。」', canon: { entities: [{ id: 'e1', name: '李明远', kind: 'character', alive: true }] } });
  assert.equal(review.modelChecked, false);
  assert.equal(review.ok, true);
});

test('a critic model can add findings', async () => {
  const guard = new ContinuityGuard({
    client: { complete: async () => '{"violations":[{"severity":"error","detail":"人物前后矛盾"}]}' },
  });
  const review = await guard.review({
    narrative: '李明远道：「好。」',
    canon: { entities: [{ id: 'e1', name: '李明远', kind: 'character', alive: true }] },
  });

  assert.equal(review.modelChecked, true);
  assert.equal(review.ok, false);
  assert.equal(review.violations[0].rule, 'critic');
});

test('a critic model cannot clear a deterministic error', async () => {
  const guard = new ContinuityGuard({ client: { complete: async () => '{"violations":[]}' } });
  const review = await guard.review({
    narrative: '赵鹏道：「我回来了。」',
    canon: { entities: [{ id: 'e1', name: '赵鹏', kind: 'character', alive: false }] },
  });

  assert.equal(review.ok, false, 'the deterministic finding stands');
  assert.ok(review.violations.some(v => v.rule === 'dead_character_speaks'));
});

test('a failing or malformed critic degrades to the deterministic result', async () => {
  const canonical = {
    narrative: '赵鹏道：「我回来了。」',
    canon: { entities: [{ id: 'e1', name: '赵鹏', kind: 'character', alive: false }] },
  };

  const throwing = new ContinuityGuard({ client: { complete: async () => { throw new Error('down'); } } });
  const a = await throwing.review(canonical);
  assert.equal(a.modelChecked, false);
  assert.equal(a.ok, false);

  const garbage = new ContinuityGuard({ client: { complete: async () => '嗯，看起来没问题' } });
  const b = await garbage.review(canonical);
  assert.equal(b.modelChecked, true);
  assert.equal(b.ok, false, 'garbage output adds nothing but removes nothing');

  const wrongShape = new ContinuityGuard({ client: { complete: async () => '{"violations":"nope"}' } });
  const c = await wrongShape.review(canonical);
  assert.equal(c.ok, false);
});

// ── Rewrite, end to end ──────────────────────────────────────────────────────

test('a contradiction is caught and sent back for one rewrite', async () => {
  const rewrites = [];
  const prompts = [];
  const { runtime } = makeRuntime({
    fetchOpts: {
      narratives: [
        '赵鹏道：「谁在那儿？」\n脚步声逼近。',
        '巡捕房的灯还亮着，街上空无一人。',
      ],
      onBody: body => { if (body.stream) prompts.push(body.messages[0].content); },
      extraction: sampleExtraction({ summary: '改写后的回合' }),
    },
    runtimeOpts: { onRewrite: info => rewrites.push(info) },
  });
  await loadWorld(runtime);
  kill(runtime, '赵鹏');

  const result = await runtime.runTurn();

  assert.equal(rewrites.length, 1, 'exactly one rewrite was requested');
  assert.match(rewrites[0].violations[0].detail, /赵鹏 已经死亡/);

  assert.equal(prompts.length, 2, 'the narrative was streamed twice');
  assert.match(prompts[1], /连续性问题/, 'the rewrite prompt carries the violations');
  assert.match(prompts[1], /赵鹏 已经死亡/);

  assert.match(result.narrativeText, /巡捕房的灯还亮着/, 'the accepted prose is the rewrite');
  assert.equal(result.continuity.rewrites, 1);
  assert.equal(result.continuity.ok, true);
  assert.equal(result.summary, '改写后的回合', 'extraction runs on the accepted prose');
});

test('a turn that still contradicts canon is committed but flagged', async () => {
  const { runtime } = makeRuntime({
    fetchOpts: { narratives: ['赵鹏道：「我回来了。」'] },
  });
  await loadWorld(runtime);
  kill(runtime, '赵鹏');

  const result = await runtime.runTurn();

  assert.equal(result.continuity.ok, false);
  assert.equal(result.continuity.rewrites, 1, 'one rewrite was attempted');
  assert.equal(runtime.getState().canon.turn, 1, 'the turn still commits — the prose exists');
  assert.ok(
    runtime.getState().turns[0].continuityWarnings.some(w => w.includes('赵鹏')),
    'the record is marked so the caller can surface it'
  );
});

test('clean prose is never rewritten', async () => {
  const rewrites = [];
  const { runtime } = makeRuntime({
    fetchOpts: { narratives: ['李明远道：「名单在哪？」'] },
    runtimeOpts: { onRewrite: info => rewrites.push(info) },
  });
  await loadWorld(runtime);

  const result = await runtime.runTurn();

  assert.deepEqual(rewrites, []);
  assert.equal(result.continuity.rewrites, 0);
  assert.equal(result.continuity.ok, true);
});

test('rewrites can be disabled', async () => {
  const rewrites = [];
  const { runtime } = makeRuntime({
    fetchOpts: { narratives: ['赵鹏道：「我回来了。」'] },
    runtimeOpts: { maxRewrites: 0, onRewrite: info => rewrites.push(info) },
  });
  await loadWorld(runtime);
  kill(runtime, '赵鹏');

  const result = await runtime.runTurn();

  assert.deepEqual(rewrites, []);
  assert.equal(result.continuity.rewrites, 0);
  assert.equal(result.continuity.ok, false);
});

test('a secret leak in character mode is caught and rewritten', async () => {
  let prompts = [];
  const { runtime } = makeRuntime({
    fetchOpts: {
      narratives: [
        '谢云舒知道他就是地下党联络员。',
        '谢云舒看了他一眼，什么也没说。',
      ],
      onBody: body => { if (body.stream) prompts.push(body.messages[0].content); },
    },
  });
  await loadWorld(runtime);
  const xie = runtime.getCharacter('谢云舒');
  runtime.setMode('character', xie.id);

  const result = await runtime.runTurn();

  assert.equal(result.continuity.rewrites, 1);
  assert.match(prompts[1], /无从知晓的秘密被写出/);
  assert.equal(result.continuity.ok, true);
});

// ── Cost observability ───────────────────────────────────────────────────────

test('a turn reports its own token usage', async () => {
  const { runtime } = makeRuntime({
    fetchOpts: { usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } },
  });
  await loadWorld(runtime);
  runtime.resetUsage();

  const result = await runtime.runTurn();

  assert.ok(result.usage.calls >= 2, 'narrative and extraction both ran');
  assert.ok(
    result.usage.totalTokens >= 140,
    'the reported call is counted on top of the streamed one'
  );
  assert.ok(result.usage.promptTokens >= 100);
  // The streaming call carries no usage (the fake SSE omits it), so the turn
  // total is partly estimated — and says so rather than pretending otherwise.
  assert.equal(result.usage.estimated, true);
});

test('usage is attributed per model role', async () => {
  const { runtime } = makeRuntime({
    runtimeOpts: { models: { director: 'cheap', critic: 'cheap' } },
    fetchOpts: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  });
  await loadWorld(runtime);
  runtime.resetUsage();

  await runtime.runTurn();
  const usage = runtime.usage;

  assert.deepEqual(Object.keys(usage.byRole).sort(), ['critic', 'director', 'extraction', 'narrative']);
  for (const role of Object.values(usage.byRole)) {
    assert.ok(role.calls >= 1, 'every configured role was actually called');
  }
  assert.equal(usage.totalTokens, usage.byRole.narrative.totalTokens
    + usage.byRole.extraction.totalTokens
    + usage.byRole.director.totalTokens
    + usage.byRole.critic.totalTokens);
});

test('missing provider usage is recorded as an estimate, not a silent zero', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  runtime.resetUsage();

  const result = await runtime.runTurn();

  assert.ok(result.usage.calls >= 2);
  assert.equal(result.usage.estimated, true);
  assert.ok(result.usage.totalTokens > 0, 'an estimate is still a number');
});

test('resetUsage clears the counters', async () => {
  const { runtime } = makeRuntime();
  await loadWorld(runtime);
  await runtime.runTurn();
  assert.ok(runtime.usage.calls > 0);

  runtime.resetUsage();
  assert.equal(runtime.usage.calls, 0);
  assert.equal(runtime.usage.totalTokens, 0);
});

// ── Usage primitives ─────────────────────────────────────────────────────────

test('the tracker accumulates and diffs', () => {
  const tracker = new UsageTracker();
  tracker.add({ promptTokens: 10, completionTokens: 5 });
  tracker.add({ promptTokens: 1, completionTokens: 1, estimated: true });

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.calls, 2);
  assert.equal(snapshot.totalTokens, 17);
  assert.equal(snapshot.estimated, true);

  const delta = diffUsage(snapshot, { ...snapshot, calls: snapshot.calls + 1, totalTokens: snapshot.totalTokens + 100 });
  assert.equal(delta.calls, 1);
  assert.equal(delta.totalTokens, 100);
});

test('sumUsage merges across roles and propagates the estimate flag', () => {
  const merged = sumUsage(
    { calls: 1, promptTokens: 5, completionTokens: 5, totalTokens: 10, estimated: false },
    { calls: 2, promptTokens: 1, completionTokens: 1, totalTokens: 2, estimated: true },
    null
  );
  assert.equal(merged.calls, 3);
  assert.equal(merged.totalTokens, 12);
  assert.equal(merged.estimated, true);
});

test('provider usage shapes are normalized, including camelCase', () => {
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }),
    { promptTokens: 3, completionTokens: 4, totalTokens: 7 }
  );
  assert.deepEqual(
    normalizeUsage({ promptTokens: 3, completionTokens: 4 }),
    { promptTokens: 3, completionTokens: 4, totalTokens: 7 }
  );
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage(null), null);
});

test('estimateTokens handles CJK and latin and empty input', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.ok(estimateTokens('一二三四') >= 2);
  assert.ok(estimateTokens('hello world') > 0);
});
