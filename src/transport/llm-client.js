/**
 * ELN Core — Transport / LLM Client
 *
 * Speaks the OpenAI-compatible chat-completions protocol. Contains no narrative
 * semantics (DESIGN §1 layer rules) — it only sends, streams, retries and
 * parses.
 *
 * Fixed relative to 0.1.0:
 *
 *  1. **SSE chunk-boundary loss.** 0.1.0 split each network chunk on '\n' and
 *     parsed the fragments immediately, so a `data:` line straddling a chunk
 *     boundary was silently dropped by the `catch {}`. This client keeps a
 *     carry-over buffer and only consumes complete lines.
 *  2. **`[DONE]` handling.** 0.1.0 `break`-ed only the inner loop; the reader
 *     kept spinning. Here `[DONE]` terminates the read.
 *  3. **No timeout / abort / retry.** Added, with the important rule that a
 *     *stream* is never retried once tokens have been emitted — re-running would
 *     duplicate prose. Connection failures before the first token are retried.
 */

import { UsageTracker, normalizeUsage, estimateTokens } from './usage.js';

/** HTTP statuses worth retrying: transient or rate-limited. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class LLMError extends Error {
  constructor(message, { status = 0, retryable = false, body = '' } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Combine two abort signals without requiring `AbortSignal.any` (Node 18 compat).
 * @returns {{signal: AbortSignal, cleanup: () => void}}
 */
function combineSignals(a, b) {
  if (!a) return { signal: b, cleanup: () => {} };
  if (!b) return { signal: a, cleanup: () => {} };

  const controller = new AbortController();
  const onAbort = why => controller.abort(why);
  if (a.aborted || b.aborted) controller.abort();

  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      a.removeEventListener('abort', onAbort);
      b.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Incremental server-sent-events parser.
 *
 * `push` accepts an arbitrary text chunk and returns the complete `data:`
 * payloads it contains. Partial trailing lines stay in an internal buffer until
 * their remainder arrives — this is the fix for the dropped-token bug.
 */
export function createSSEParser() {
  let buffer = '';
  let done = false;

  const drain = () => {
    const events = [];
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { done = true; continue; }
      if (data) events.push(data);
    }
    return events;
  };

  return {
    push(chunk) {
      buffer += chunk;
      return drain();
    },
    get done() { return done; },
    /** Consume any final line that arrived without a trailing newline. */
    flush() {
      if (!buffer.length) return [];
      buffer += '\n';
      return drain();
    },
  };
}

export class LLMClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.apiBase]   - Default: https://api.deepseek.com
   * @param {string} [options.model]     - Default: deepseek-chat
   * @param {number} [options.timeout]   - Per-request timeout in ms
   * @param {number} [options.maxRetries]
   * @param {number} [options.retryDelay] - Base backoff in ms
   * @param {typeof fetch} [options.fetchImpl] - Injection point for tests
   */
  constructor({
    apiKey,
    apiBase = 'https://api.deepseek.com',
    model = 'deepseek-chat',
    timeout = 120_000,
    maxRetries = 2,
    retryDelay = 300,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('[ELN] apiKey is required');
    if (typeof fetchImpl !== 'function') throw new Error('[ELN] No fetch implementation available');
    this.apiKey = apiKey;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.model = model;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
    this._fetch = fetchImpl;

    /** Cumulative token usage for this model role. See `transport/usage.js`. */
    this.usage = new UsageTracker();
  }

  /** Forget accumulated usage (e.g. to measure a single turn). */
  resetUsage() {
    this.usage.reset();
    return this;
  }

  _body(prompt, { maxTokens, stream, model, temperature }) {
    const body = {
      model: model ?? this.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    };
    if (stream) {
      body.stream = true;
      // Ask for a trailing usage chunk; providers that ignore it simply omit it
      // and the caller falls back to an estimate.
      body.stream_options = { include_usage: true };
    }
    if (temperature !== undefined) body.temperature = temperature;
    return body;
  }

  /**
   * Issue a request with timeout, abort and bounded retries.
   *
   * Retries cover network failures and retryable statuses. The returned
   * Response body is unconsumed, so a `stream` caller can decide for itself
   * whether a mid-body failure is recoverable.
   *
   * @returns {Promise<Response>}
   */
  async _request(body, { signal } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('[ELN] request timed out')), this.timeout);
      const combined = combineSignals(signal, controller.signal);

      try {
        const resp = await this._fetch(`${this.apiBase}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: combined.signal,
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          const error = new LLMError(`[ELN] LLM API ${resp.status}: ${text}`, {
            status: resp.status,
            retryable: RETRYABLE_STATUS.has(resp.status),
            body: text,
          });
          if (!error.retryable) throw error;
          lastError = error;
        } else {
          return resp;
        }
      } catch (error) {
        if (error instanceof LLMError && !error.retryable) throw error;
        // Caller-initiated abort is never retried.
        if (signal?.aborted) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
        combined.cleanup();
      }

      if (attempt < this.maxRetries) {
        await sleep(this.retryDelay * 2 ** attempt);
      }
    }

    throw lastError ?? new LLMError('[ELN] request failed');
  }

  /**
   * Non-streaming completion.
   * @returns {Promise<string>}
   */
  async complete(prompt, { maxTokens = 1200, signal, model, temperature } = {}) {
    const resp = await this._request(this._body(prompt, { maxTokens, stream: false, model, temperature }), { signal });
    const data = await resp.json();
    if (data.error) throw new LLMError(`[ELN] LLM error: ${data.error.message}`, { retryable: false });

    const content = data.choices?.[0]?.message?.content ?? '';
    const reported = normalizeUsage(data.usage);
    if (reported) {
      this.usage.add(reported);
    } else {
      this.usage.add({
        promptTokens: estimateTokens(prompt),
        completionTokens: estimateTokens(content),
        estimated: true,
      });
    }
    return content;
  }

  /**
   * Streaming completion. `onToken` receives each text delta; the full text is
   * returned. A failure after the first token is **not** retried.
   *
   * @param {string} prompt
   * @param {(token: string) => void} onToken
   * @returns {Promise<string>}
   */
  async stream(prompt, onToken, { maxTokens = 3000, signal, model, temperature } = {}) {
    const resp = await this._request(this._body(prompt, { maxTokens, stream: true, model, temperature }), { signal });

    if (!resp.body) throw new LLMError('[ELN] streaming response has no body', { retryable: false });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSSEParser();
    let fullText = '';
    let reportedUsage = null;

    const handle = payload => {
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        // A malformed *complete* payload is genuinely bad data; skip it rather
        // than abort the whole turn.
        return;
      }
      // OpenAI-compatible streams emit usage on the final chunk (choices empty).
      const usage = normalizeUsage(json.usage);
      if (usage) reportedUsage = usage;

      const delta = json.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        fullText += delta;
        onToken?.(delta);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) handle(payload);
        if (parser.done) break;
      }
      // Flush whatever is left in the decoder and the line buffer.
      for (const payload of parser.push(decoder.decode())) handle(payload);
      for (const payload of parser.flush()) handle(payload);
    } finally {
      reader.releaseLock?.();
    }

    if (reportedUsage) {
      this.usage.add(reportedUsage);
    } else {
      // Streams frequently omit usage; record an explicit estimate rather than
      // reporting a silent zero.
      this.usage.add({
        promptTokens: estimateTokens(prompt),
        completionTokens: estimateTokens(fullText),
        estimated: true,
      });
    }

    return fullText;
  }

  /**
   * Parse a JSON object out of an LLM response, tolerating fences and preamble.
   * @param {string} text
   */
  static parseJSON(text) {
    if (typeof text !== 'string') throw new Error('[ELN] No JSON found in LLM response');
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e < 0) throw new Error('[ELN] No JSON found in LLM response');
    return JSON.parse(text.slice(s, e + 1));
  }
}
