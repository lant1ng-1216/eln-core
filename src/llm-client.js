/**
 * ELN Core — LLM Client
 *
 * Thin wrapper around LLM APIs.
 * Default: DeepSeek-compatible API (OpenAI-format).
 * Swap `apiBase` to use OpenAI, Moonshot, Qwen, or any compatible endpoint.
 */

export class LLMClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.apiBase]  - Default: https://api.deepseek.com
   * @param {string} [options.model]    - Default: deepseek-chat
   */
  constructor({ apiKey, apiBase = 'https://api.deepseek.com', model = 'deepseek-chat' }) {
    if (!apiKey) throw new Error('[ELN] apiKey is required');
    this.apiKey = apiKey;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.model = model;
  }

  /**
   * Non-streaming completion. Returns full response text.
   *
   * @param {string} prompt
   * @param {number} [maxTokens]
   * @returns {Promise<string>}
   */
  async complete(prompt, maxTokens = 1200) {
    const resp = await fetch(`${this.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`[ELN] LLM API ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    if (data.error) throw new Error(`[ELN] LLM error: ${data.error.message}`);
    return data.choices?.[0]?.message?.content ?? '';
  }

  /**
   * Streaming completion. Calls onToken for each chunk, returns full text.
   *
   * @param {string}   prompt
   * @param {Function} onToken     - Called with each text delta (string)
   * @param {number}   [maxTokens]
   * @returns {Promise<string>}    - Full accumulated text
   */
  async stream(prompt, onToken, maxTokens = 3000) {
    const resp = await fetch(`${this.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`[ELN] LLM API ${resp.status}: ${text}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const rawLine of chunk.split('\n')) {
        if (!rawLine.startsWith('data:')) continue;
        const data = rawLine.slice(5).trim();
        if (data === '[DONE]') break;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            fullText += delta;
            onToken(delta);
          }
        } catch {}
      }
    }

    return fullText;
  }

  /**
   * Parse a JSON response from LLM (handles model preamble/fences gracefully).
   *
   * @param {string} text
   * @returns {object}
   */
  static parseJSON(text) {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e < 0) throw new Error('[ELN] No JSON found in LLM response');
    return JSON.parse(text.slice(s, e + 1));
  }
}
