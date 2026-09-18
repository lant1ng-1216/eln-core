/**
 * ELN Core — Expression / Style packs
 *
 * Language and register, separate from genre (DESIGN §6). This is what makes
 * "add an English prompt style" a data contribution rather than a code change —
 * one of the contributions CONTRIBUTING.md asks for.
 */

/**
 * @typedef {Object} StylePack
 * @property {'style'} kind
 * @property {string} key
 * @property {string} name
 * @property {string} language
 * @property {string} instruction - Register/voice guidance injected verbatim
 * @property {string} dialogueLabel - Word used to introduce a line of dialogue
 * @property {string} monologueLabel - Word used for the inner-monologue prefix
 */

/** @type {Record<string, StylePack>} */
export const STYLE_PACKS = {
  'zh-literary': {
    kind: 'style',
    key: 'zh-literary',
    name: '中文白话',
    language: 'zh',
    instruction: '用现代中文白话书写，文笔讲究但不过度堆砌辞藻。感官细节服务于情绪与信息，不做无意义的景物铺陈。',
    dialogueLabel: '道',
    monologueLabel: '内心',
  },

  'zh-classical': {
    kind: 'style',
    key: 'zh-classical',
    name: '中文文言',
    language: 'zh',
    instruction: '以浅近文言书写，句式凝练，善用典故与对仗。对话简洁而有分量，避免白话口语。',
    dialogueLabel: '曰',
    monologueLabel: '心念',
  },

  'en-literary': {
    kind: 'style',
    key: 'en-literary',
    name: 'English literary',
    language: 'en',
    instruction: 'Write in literary English. Favour concrete sensory detail and subtext over exposition. Keep sentences varied and controlled.',
    dialogueLabel: 'says',
    monologueLabel: 'inner',
  },
};

/** Wrap a style key (or a raw pack object) into a pack. */
export function stylePack(keyOrPack) {
  if (keyOrPack && typeof keyOrPack === 'object' && keyOrPack.kind === 'style') return keyOrPack;
  const pack = STYLE_PACKS[keyOrPack];
  if (!pack) {
    throw new Error(
      `[ELN] Unknown style pack "${keyOrPack}". Available: ${Object.keys(STYLE_PACKS).join(', ')}`
    );
  }
  return pack;
}

export const STYLE_KEYS = Object.freeze(Object.keys(STYLE_PACKS));
