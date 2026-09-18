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

/**
 * Build the retry prompt. Only the failed blocks are asked for again, and the
 * concrete zod message is included — models fix "expected number, received
 * string" far more reliably than a bare "invalid JSON".
 */
export function buildRepairPrompt(originalPrompt, degraded, errors) {
  const detail = degraded
    .map(name => `- ${name}: ${errors[name] ?? 'invalid'}`)
    .join('\n');

  const blocks = [...new Set(degraded.map(d => d.replace(/\[\d+\]$/, '')))];

  return `${originalPrompt}

---
你上一次的输出中以下部分不符合 schema，请修正后**只返回一个完整 JSON 对象**（不要解释）：
${detail}

必须正确包含这些块：${blocks.join('、')}`;
}

async function runOnce(client, prompt, maxTokens) {
  // A transport failure is hard: it propagates so the caller can roll the turn
  // back. A *content* failure is soft: unparseable output is treated as a
  // degraded root, which makes it repairable instead of fatal.
  const text = await client.complete(prompt, { maxTokens });

  try {
    return validateExtraction(parseJSONLoose(text));
  } catch (error) {
    return {
      blocks: {},
      degraded: ['root'],
      errors: { root: `unparseable response: ${error.message}` },
    };
  }
}

/** Did this attempt actually try, and fail, to produce `name`? */
function attempted(name, result) {
  return result.degraded.some(d => d === name || d.startsWith(`${name}[`));
}

/**
 * Per-block merge: first validated attempt wins; otherwise take the retry's.
 * Item-level losses (`characters[3]`) are inherited from whichever attempt's
 * array was actually adopted.
 *
 * A block that is merely *absent* from both attempts is not degraded — the
 * extraction schema has many optional blocks, and omitting one is not a failure.
 * Only a block that was present and failed is reported.
 */
function merge(first, second) {
  const blocks = {};
  const degraded = [];
  const errors = {};

  for (const name of BLOCK_NAMES) {
    const a = first.blocks[name];
    const b = second.blocks[name];
    const source = a !== undefined ? first : b !== undefined ? second : null;

    if (!source) {
      if (attempted(name, first) || attempted(name, second)) {
        degraded.push(name);
        errors[name] = first.errors[name] ?? second.errors[name];
      }
      continue;
    }

    blocks[name] = source.blocks[name];
    for (const d of source.degraded) {
      if (d === name || d.startsWith(`${name}[`)) degraded.push(d);
    }
    for (const [key, msg] of Object.entries(source.errors)) {
      if (key === name || key.startsWith(`${name}[`)) errors[key] = msg;
    }
  }

  // Neither attempt produced usable JSON: report the root cause rather than
  // listing every block as independently broken.
  if (Object.keys(blocks).length === 0) {
    const root = first.errors.root ?? second.errors.root;
    if (root) return { blocks, degraded: ['root'], errors: { root } };
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

  const retryPrompt = buildRepairPrompt(prompt, first.degraded, first.errors);
  let second;
  try {
    second = await runOnce(client, retryPrompt, maxTokens);
  } catch (error) {
    // A failed retry must not lose the first attempt's good blocks.
    return { ...first, attempts: 1, repairError: String(error?.message ?? error) };
  }

  return { ...merge(first, second), attempts: 2 };
}
