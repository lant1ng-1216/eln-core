/**
 * ELN Core — Transport / Usage accounting
 *
 * Cost routing (DESIGN §9 P4) is only useful if the cost is observable: "use a
 * cheap model for extraction" is a claim you want to verify per turn.
 *
 * Providers report token usage in different shapes, and streaming responses
 * often omit it entirely. This tracker records what the provider actually said
 * and marks the result `estimated` when any part of it was inferred, so a
 * reported number is never silently half-guessed.
 */

/**
 * Rough token estimate for text. CJK text runs about 1 token per character and
 * Latin about 1 per 4, so 2 characters per token is a reasonable middle ground
 * for mixed prose. Only used when the provider reports nothing.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil([...text].length / 2);
}

export class UsageTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.calls = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.totalTokens = 0;
    /** True once any figure in this tracker was inferred rather than reported. */
    this.estimated = false;
  }

  /**
   * Record one call.
   * @param {{promptTokens?: number, completionTokens?: number, totalTokens?: number, estimated?: boolean}} usage
   */
  add({ promptTokens = 0, completionTokens = 0, totalTokens = 0, estimated = false } = {}) {
    this.calls += 1;
    this.promptTokens += promptTokens;
    this.completionTokens += completionTokens;
    this.totalTokens += totalTokens || promptTokens + completionTokens;
    if (estimated) this.estimated = true;
    return this;
  }

  /** Plain snapshot, safe to diff or serialize. */
  snapshot() {
    return {
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      estimated: this.estimated,
    };
  }
}

/** Per-call delta between two snapshots. */
export function diffUsage(before, after) {
  return {
    calls: after.calls - before.calls,
    promptTokens: after.promptTokens - before.promptTokens,
    completionTokens: after.completionTokens - before.completionTokens,
    totalTokens: after.totalTokens - before.totalTokens,
    estimated: after.estimated || before.estimated,
  };
}

/** Sum several snapshots — used to report one number across all model roles. */
export function sumUsage(...snapshots) {
  return snapshots.filter(Boolean).reduce((acc, s) => ({
    calls: acc.calls + (s.calls ?? 0),
    promptTokens: acc.promptTokens + (s.promptTokens ?? 0),
    completionTokens: acc.completionTokens + (s.completionTokens ?? 0),
    totalTokens: acc.totalTokens + (s.totalTokens ?? 0),
    estimated: acc.estimated || Boolean(s.estimated),
  }), { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false });
}

/**
 * Normalize a provider `usage` object. OpenAI-compatible APIs use
 * `prompt_tokens` / `completion_tokens` / `total_tokens`; some use camelCase.
 *
 * @returns {{promptTokens: number, completionTokens: number, totalTokens: number}|null}
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;

  const promptTokens = usage.prompt_tokens ?? usage.promptTokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.completionTokens ?? 0;
  const totalTokens = usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens;

  if (!promptTokens && !completionTokens && !totalTokens) return null;
  return { promptTokens, completionTokens, totalTokens };
}
