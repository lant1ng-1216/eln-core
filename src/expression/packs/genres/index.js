/**
 * ELN Core — Expression / Genre packs
 *
 * Genre is **data**, not code (DESIGN §6). `compose()` injects `worldview` and
 * `tone` from here instead of hardcoding them, which fixes the 0.1.0 bug where
 * every template — xianxia, campus, apocalypse — was narrated as a historical
 * spy thriller (`prompts.js:108`).
 *
 * Adding a genre means adding an object to this file (or passing a custom pack);
 * no prompt-building code changes.
 */

/**
 * @typedef {Object} GenrePack
 * @property {'genre'} kind
 * @property {string} key
 * @property {string} name
 * @property {string} worldview - World constraints the narrative must respect
 * @property {string} tone      - Narrative voice and register
 * @property {string[]} tropes  - Available plot devices for this genre
 */

/** @type {Record<string, GenrePack>} */
export const GENRE_PACKS = {
  ancient: {
    kind: 'genre',
    key: 'ancient',
    name: '古代权谋',
    worldview: '架空或真实的古代王朝，礼法森严，权力通过血缘、门第、军功与圣眷流转。信息靠人力传递，一道口谕、一封密折即可决定生死。',
    tone: '半文半白、含蓄克制，讲究留白与机锋。对话暗藏试探，情绪不外露。',
    tropes: ['朝堂对峙', '密折举发', '赐婚联姻', '边关军报', '后宫倾轧', '托孤遗诏'],
  },

  republican: {
    kind: 'genre',
    key: 'republican',
    name: '民国谍战',
    worldview: '民国乱世，多方势力交错（租界、军统、地下党、日谍、帮会）。身份是最大的武器，人人戴着面具生活，一句话说错就是灭顶之灾。',
    tone: '冷峻、克制、多线并行。大量留白与潜台词，用动作和细节代替直白情绪。',
    tropes: ['暗号接头', '身份暴露危机', '假夫妻真情感', '双面间谍', '密码本争夺', '酒后失言'],
  },

  mystery: {
    kind: 'genre',
    key: 'mystery',
    name: '现代悬疑',
    worldview: '当代都市或封闭空间（小城、孤岛、机构）。表层秩序之下藏着被掩盖的旧案，证据链与人心同样是谜题。',
    tone: '冷静、精确、节奏紧凑。以细节和逻辑推进，擅长制造不适感与悬念。',
    tropes: ['不在场证明', '关键证人失踪', '旧案重提', '不可靠叙述者', '密室', '记忆偏差'],
  },

  xianxia: {
    kind: 'genre',
    key: 'xianxia',
    name: '架空修仙',
    worldview: '灵气充盈的修真世界，境界分明（炼气、筑基、金丹、元婴……），宗门林立，天骄辈出。长生大道与人心欲望彼此撕扯。',
    tone: '飘逸大气、意象宏阔，兼有古意与热血。战斗写意，修行写境。',
    tropes: ['秘境夺宝', '宗门大比', '道心破碎', '渡劫飞升', '师徒禁忌', '剑意初成'],
  },

  campus: {
    kind: 'genre',
    key: 'campus',
    name: '校园青春',
    worldview: '当代高中或大学校园，学业、社团、家庭与情愫交织。世界很小，但每一件小事在当时都像天塌下来。',
    tone: '明亮细腻、口语化，善写少年心事的微妙起伏，克制不矫情。',
    tropes: ['天台谈心', '毕业季离别', '暗恋心事', '社团比赛', '家庭压力', '重逢旧友'],
  },

  apocalypse: {
    kind: 'genre',
    key: 'apocalypse',
    name: '末世求生',
    worldview: '文明崩塌后的废墟世界，资源极度匮乏，秩序让位于生存法则。最危险的不是怪物，而是同样求生的人。',
    tone: '粗粝、紧绷、感官性强。用具体的物资与身体感受写绝境中的选择。',
    tropes: ['物资争夺', '感染者潮', '幸存者营地', '信任崩塌', '无线电求救', '牺牲换取生机'],
  },
};

/** Wrap a genre key (or a raw pack object) into a pack. */
export function genrePack(keyOrPack) {
  if (keyOrPack && typeof keyOrPack === 'object' && keyOrPack.kind === 'genre') return keyOrPack;
  const pack = GENRE_PACKS[keyOrPack];
  if (!pack) {
    throw new Error(
      `[ELN] Unknown genre pack "${keyOrPack}". Available: ${Object.keys(GENRE_PACKS).join(', ')}`
    );
  }
  return pack;
}

export const GENRE_KEYS = Object.freeze(Object.keys(GENRE_PACKS));
