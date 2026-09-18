/**
 * ELN Core — Orchestration / Repair
 *
 * DESIGN §5.1 step 5: a failed extraction is retried once, carrying the
 * validation error back to the model. A second failure does not abort the turn
 * — the surviving blocks are committed and the turn is marked degraded, which is
 * what the block-level validation in `contracts/validate.js` makes possible.
 *
 * Merge rule: for each block, the **first attempt wins if it validated**; the
 * retry only fills in blocks the first attempt lost. A retry can therefore never
 * silently replace content that already passed validation.
 */

import { validateExtraction, parseJSONLoose } from '../contracts/validate.js';

/** Every block `validateExtraction` may produce. */
export const BLOCK_NAMES = Object.freeze([
  'summary', 'world', 'editor', 'characters', 'facts', 'events',
  'seeds', 'seed_payoffs', 'reveals_secret', 'knowledge',
]);

/** Guidance for a response that was cut off by the token cap. */
const COMPACTNESS = `
你上一次的输出超过长度上限被**截断**了，JSON 因此不完整。这次务必更紧凑：
- evidence 每条不超过 15 字，且不要复述正文
- facts 最多 6 条，events 最多 4 条，seeds 最多 2 条，characters 只列有变化的
- 不要输出未发生变化的世界字段`;

/**
 * Build the retry prompt. Only the failed blocks are asked for again, and the
 * concrete zod message is included — models fix "expected number, received
 * string" far more reliably than a bare "invalid JSON".
 *
 * Truncation gets its own instruction: telling a model "expected ',' or ']'"
 * when the real problem is that it ran out of room produces another verbose
 * response that truncates again.
 */
export function buildRepairPrompt(originalPrompt, degraded, errors, { truncated = false } = {}) {
  const detail = degraded
    .map(name => `- ${name}: ${errors[name] ?? 'invalid'}`)
    .join('\n');

  const blocks = [...new Set(degraded.map(d => d.replace(/\[\d+\]$/, '')))];

  return `${originalPrompt}

---
你上一次的输出中以下部分不符合 schema，请修正后**只返回一个完整 JSON 对象**（不要解释）：
${detail}

必须正确包含这些块：${blocks.join('、')}${truncated ? `\n${COMPACTNESS}` : ''}`;
}

async function runOnce(client, prompt, maxTokens) {
  // A transport failure is hard: it propagates so the caller can roll the turn
  // back. A *content* failure is soft: unparseable output is treated as a
  // degraded root, which makes it repairable instead of fatal.
  //
  // `finishReason` is requested so truncation is diagnosed as truncation rather
  // than as malformed data — the remedies are different.
  const meta = typeof client.completeWithMeta === 'function'
    ? await client.completeWithMeta(prompt, { maxTokens })
    : { content: await client.complete(prompt, { maxTokens }), finishReason: null };

  const text = meta.content ?? '';
  const truncated = meta.finishReason === 'length';

  try {
    const result = validateExtraction(parseJSONLoose(text));
    if (truncated) {
      // It happened to parse, but the payload was cut short: some of the turn
      // was silently lost, so say so.
      result.degraded = [...result.degraded, 'truncated'];
      result.errors = { ...result.errors, truncated: `输出达到 max_tokens=${maxTokens} 上限` };
    }
    return { ...result, truncated };
  } catch (error) {
    return {
      blocks: {},
      degraded: ['root'],
      errors: {
        root: truncated
          ? `输出被 max_tokens=${maxTokens} 截断，JSON 不完整`
          : `unparseable response: ${error.message}`,
      },
      truncated,
    };
  }
}

/** Did this attempt actually try, and fail, to produce `name`? */
function attempted(name, result) {
  return result.degraded.some(d => d === name || d.startsWith(`${name}[`));
}

/**
 * Per-block merge. A validated attempt wins, **unless it was truncated** — a
 * cut-off response is known to be incomplete, so a complete retry supersedes it
 * even though the first one technically parsed.
 *
 * Item-level losses (`characters[3]`) are inherited from whichever attempt's
 * array was actually adopted. A block that is merely *absent* from both is not
 * degraded: the schema has many optional blocks, and omitting one is not a
 * failure. Only a block that was present and failed is reported.
 */
function merge(first, second) {
  const blocks = {};
  const degraded = [];
  const errors = {};
  let adoptedTruncated = false;

  for (const name of BLOCK_NAMES) {
    const a = first.blocks[name];
    const b = second.blocks[name];

    let source = null;
    if (a !== undefined && b !== undefined) source = first.truncated ? second : first;
    else if (a !== undefined) source = first;
    else if (b !== undefined) source = second;

    if (!source) {
      if (attempted(name, first) || attempted(name, second)) {
        degraded.push(name);
        errors[name] = first.errors[name] ?? second.errors[name];
      }
      continue;
    }

    if (source.truncated) adoptedTruncated = true;

    blocks[name] = source.blocks[name];
    for (const d of source.degraded) {
      if (d === name || d.startsWith(`${name}[`)) degraded.push(d);
    }
    for (const [key, msg] of Object.entries(source.errors)) {
      if (key === name || key.startsWith(`${name}[`)) errors[key] = msg;
    }
  }

  // Neither attempt produced usable JSON: report the root cause rather than
  // listing every block as independently broken. The *later* error is preferred
  // because it reflects the largest budget that was tried.
  if (Object.keys(blocks).length === 0) {
    const root = second.errors.root ?? first.errors.root;
    if (root) return { blocks, degraded: ['root'], errors: { root } };
  }

  // Flag only when the content actually adopted came from a truncated attempt:
  // if the retry was complete, nothing was lost and crying wolf would train the
  // caller to ignore the marker.
  if (adoptedTruncated) {
    degraded.push('truncated');
    errors.truncated ??= '抽取输出曾达到 max_tokens 上限，可能有部分内容丢失';
  }

  return { blocks, degraded, errors };
}

/**
 * Run extraction with at most one repair attempt.
 *
 * @param {Object} input
 * @param {{complete: Function}} input.client
 * @param {string} input.prompt
 * @param {number} [input.maxTokens]
 * @param {number} [input.maxRepair] - 0 disables repair
 * @returns {Promise<{blocks: object, degraded: string[], errors: object, attempts: number}>}
 */
export async function extractWithRepair({ client, prompt, maxTokens = 900, maxRepair = 1 }) {
  const first = await runOnce(client, prompt, maxTokens);

  if (!first.degraded.length || maxRepair <= 0) {
    return { ...first, attempts: 1 };
  }

  // A truncated response gets a bigger budget *and* a compactness instruction:
  // the instruction fixes the cause, the budget covers a model that ignores it.
  const retryBudget = first.truncated ? Math.round(maxTokens * 1.5) : maxTokens;
  const retryPrompt = buildRepairPrompt(prompt, first.degraded, first.errors, {
    truncated: first.truncated,
  });

  let second;
  try {
    second = await runOnce(client, retryPrompt, retryBudget);
  } catch (error) {
    // A failed retry must not lose the first attempt's good blocks.
    return { ...first, attempts: 1, repairError: String(error?.message ?? error) };
  }

  return { ...merge(first, second), attempts: 2 };
}
