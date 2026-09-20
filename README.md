# eln-core

**开源 AI 叙事世界引擎 · 有状态模型的叙事运行时**

[ELN · 空镜叙事] 的核心 Runtime，已提炼为独立开源库。

```
Canon（客观真相） ──投影──▶ Mind（各主体私有视角）──装配──▶ Prompt ──▶ 流式叙事 ──▶ 抽取 ──▶ 提交
       ▲                                                                                    │
       └──────────────────────── 事务化回合，失败即回滚 ────────────────────────────────────┘
```

> **0.2.0 是破坏性升级**，从"一条双调用回合链"重写为有状态模型的运行时。迁移指引见
> [CHANGELOG.md](CHANGELOG.md)，设计依据见 [DESIGN.md](DESIGN.md)。

---

## 这是什么

`eln-core` 驱动**可持久化的 AI 故事世界**。与 0.1.0 的关键差别：

| 能力 | 说明 |
|---|---|
| **信息差** | 状态分两层：`Canon` 是客观真相，`Mind` 是每个角色各自知道/怀疑/误信的东西。`Mind` 不是 `Canon` 的子集，而是**可以出错的映射**——误会、谎言、戏剧反讽由此自然涌现。 |
| **长期记忆** | 正文逐回合留存并可检索，事件账本记录"真正发生了什么"及其因果链，伏笔账本追踪埋下的线是否回收。第 6 回合仍能引用第 2 回合的细节。 |
| **导演层** | 每回合先规划 `BeatSpec`：必须推进谁的目标、必须处理哪条伏笔、张力目标、收尾钩子。给的是**戏剧指令**，不是文风指令。逾期的伏笔会升级为硬性要求，直到被回收。 |
| **章节自收尾** | 章节按判据收尾：承诺回收的伏笔已回收、目标已达成，或回合预算耗尽。不需要你记得调用 `nextChapter()`。 |
| **视角可切换** | `director`（全知）与 `character`（有限视角）是同一次投影，只换 `holderId`。切模式不改状态，来回切换无损耗。角色模式不仅过滤情报，还按该角色的错误认知叙述。 |
| **回合即事务** | 任一步失败则整回合回滚，计数器绝不漂移。 |
| **连续性守卫** | 抽取之前先查正文：已死亡的角色开口、有限视角写出无从知晓的秘密——确定性检出并打回重写一次。 |
| **角色智能体** | 角色会背着你行动：按各自目标在幕后制造事件（`source:'agent'`），导演再把这些幕后动作变成下一场戏的义务。 |
| **成本可观测** | 每次调用的 token 用量按模型角色记账，区分"服务商上报"与"估算"。 |

**UI 无关 · 题材/文风/存储/检索全部可插拔。**

---

## 安装

```bash
npm install @lant1ng/eln-core
```

运行依赖仅 `zod`（契约校验）。浏览器中可直接使用 ESM CDN：

```html
<script type="module">
  import { ELNRuntime } from 'https://esm.sh/@lant1ng/eln-core'
</script>
```

---

## 快速上手

```js
import { ELNRuntime, genrePack, stylePack } from '@lant1ng/eln-core'

const eln = new ELNRuntime({
  apiKey: process.env.DEEPSEEK_API_KEY,

  // 题材与文风是数据，不是代码
  packs: [genrePack('republican'), stylePack('zh-literary')],

  // 成本路由：静默抽取走便宜模型
  models: { narrative: 'deepseek-chat', extraction: 'deepseek-chat' },

  onToken: t => process.stdout.write(t),
  onTurnEnd: r => console.log('\n摘要:', r.summary, '| 张力:', r.canon.tension),
})

// 1. 生成并载入世界
const world = await eln.generateWorld({ genre: 'republican' })
eln.loadWorld(world)

// 2. 推进一回合
await eln.runTurn()

// 3. 上帝模式：注入事件
await eln.runTurn({ intervention: '一封神秘信件突然出现在桌上' })

// 4. 强制角色泄密（这是一次状态写入，不是提示词补丁）
eln.forceSecretReveal('李明远', '谢云舒')

// 5. 看向某个角色眼中的世界
const view = eln.getState({ perspective: eln.getCharacter('谢云舒').id })
view.visibleFacts   // 她确切知道的
view.hiddenFacts    // 她还不知道的——只有 id 与标签，没有内容
```

---

## 世界模板

```js
await eln.generateWorld({ genre: 'ancient' })     // 古代权谋
await eln.generateWorld({ genre: 'republican' })  // 民国谍战
await eln.generateWorld({ genre: 'mystery' })     // 现代悬疑
await eln.generateWorld({ genre: 'xianxia' })     // 架空修仙
await eln.generateWorld({ genre: 'campus' })      // 校园青春
await eln.generateWorld({ genre: 'apocalypse' })  // 末世求生

// 或自由描述
await eln.generateWorld({ prompt: '三个AI科学家在火星基地，其中一个是卧底' })
```

**文体风格：** `zh-literary`（中文白话）· `zh-classical`（中文文言）· `en-literary`（English literary）

加题材或加语言 = **加一个数据文件**，不需要改提示词代码（见 `src/expression/packs/`）。

---

## API 参考

### `new ELNRuntime(options)`

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | `string` | **必填** | LLM API 密钥 |
| `apiBase` | `string` | `https://api.deepseek.com` | API 地址 |
| `model` | `string` | `deepseek-chat` | 单模型简写 |
| `models` | `{narrative, extraction, director, critic, agent}` | — | 分角色模型（成本路由） |
| `packs` | `Array` | `[]` | `genrePack(...)` / `stylePack(...)` / `constraintPack(...)` |
| `mode` | `'director' \| 'character'` | `director` | 视角模式 |
| `playerEntityId` | `string` | — | character 模式必填 |
| `storage` | `StorageAdapter` | 浏览器 localStorage / Node 内存 | 持久化适配器 |
| `retriever` | `Retriever` | `KeywordRetriever` | 检索适配器（可换向量检索） |
| `onToken` / `onLine` | `(token) => void` | — | 流式回调 |
| `onTurnEnd` / `onEvent` | `(result) => void` | — | 回合 / 事件回调 |
| `onChapterEnd` | `({reason, from, to, index}) => void` | — | 章节自动收尾时触发 |
| `onRewrite` | `({attempt, violations}) => void` | — | 正文被打回重写时触发（见下） |
| `maxRewrites` | `number` | `1` | 连续性重写次数上限；0 表示只检测不改写 |
| `autoAgents` | `boolean` | `true` | 配置 `models.agent` 后是否自动运行幕后行动 |
| `maxAgents` | `number` | `2` | 每回合最多几个角色在幕后行动 |
| `tensionBand` | `number` | `20` | 张力观测值相对导演目标的允许偏差（死区） |
| `tensionCurve` | `{start,end}` | `{25,70}` | 一章内的张力弧线量程 |
| `contextBudget` | `number \| null` | `16000` | 上下文组装块的字符预算；`null` 关闭 |

> `contextBudget` 有默认值而非不限：实测 20 回合上下文增长 +497% 且无收敛迹象。
> 超预算时按优先级裁剪：检索摘录 → 伏笔账本 → 事实列表 → 剧情回顾 → 最后才动角色与世界。
> 用 `turnResult.promptChars` / `blocks.trace.blockChars` 观测增长。

> `models.director` / `models.critic` / `models.agent` 都是可选的：配置后用便宜模型补上规则
> 无法决定的部分（制造什么阻碍 / 语义校对 / 幕后行动），**失败都不影响回合**。
> 不配置则完全走确定性路径。

### 世界与回合

```js
await eln.generateWorld({ genre, prompt })   // 生成（不自动载入）
eln.loadWorld(world)                         // 载入
await eln.runTurn({ intervention?, action? })// 推进一回合
eln.getState()                               // { canon, minds, events, seeds, turns }
eln.getState({ perspective: holderId })      // 该角色的视角视图
```

### 双模式（玩家视角）

```js
// 玩家是一个普通实体 —— 没有特权通道，所以不存在越权信息
const player = eln.createPlayer({ name: '林默', role: '报馆记者', goal: '查清名单' })

eln.setMode('character', player.id)

// 玩家行动会先经导演复核（硬约束：玩家已死亡、行动涉及已死者）
// 通过后被折进本回合的戏剧任务：玩家自己的目标排进 mustAdvance 首位
await eln.runTurn({ action: '我撬开档案柜，翻找名单' })

eln.setMode('director')     // 切回全知；状态未被改动过
eln.getState({ perspective: player.id })   // 玩家眼中的世界（只含他已知的事实）
```

在 character 模式下：
- 提示词带 `【叙事视角】` 块，要求按该角色的**有限视角**叙述，他人心理只能外化暗示，
  且按其错误认知书写而不替他纠正。
- 其他角色的秘密不会出现在提示词里——这是结构保证，不是措辞约束。
- `intervention` 会抛错（用 `action` 或 `injectWorldEvent()`）；`action` 在 director 模式下会抛错。

### 上帝模式

```js
eln.setCharDirective('李明远', '本回合必须怀疑谢云舒')
eln.forceSecretReveal('李明远', '谢云舒')
eln.plantSeed('那封没寄出的信')               // 主动埋一条伏笔
eln.nextChapter('聚焦两人之间的信任危机')     // 覆盖手段；章节本就会按判据自动收尾
eln.injectWorldEvent('城外传来爆炸声')        // 只改世界，不让任何角色凭空知情
```

章节自动收尾时可以接住：

```js
new ELNRuntime({
  apiKey,
  onChapterEnd: ({ reason, from, to }) => {
    // reason: 'criteria' | 'budget' | 'editor'
    console.log(`《${from}》收尾（${reason}），进入《${to}》`)
  },
})
```

### 角色智能体（幕后行动）

配置 `models.agent` 后，角色会在每回合结束**背着你行动**：

```js
const eln = new ELNRuntime({
  apiKey,
  models: { narrative: 'deepseek-chat', extraction: 'deepseek-chat', agent: 'deepseek-chat' },
  maxAgents: 2,        // 每回合最多 2 人在幕后行动
  autoAgents: true,    // 默认开启；关掉也能手动触发
  onEvent: e => { if (e.source === 'agent') console.log('幕后:', e.summary) },
})

const result = await eln.runTurn()
result.betweenTurns   // { events, actedIds, modelChecked }
```

下一回合，这些幕后动作会作为**义务**进入导演的 beat：

```
- 幕后：李明远悄悄见了巡捕房的线人。本回合必须让此事的影响渗入场景
  （不必直写，但不能当作没发生过）
```

规则：
- **谁行动是确定性的**：已死亡或无目标的角色不能行动；玩家被排除（玩家用 `action`）。
  轮换相位与 `mustAdvance` 故意错开——台前主角和幕后操盘手不该总是同一个人。
- **做什么才用模型**：一次调用为选中角色各产出一个行动，要求服务于其自身目标、
  不得凭空引入新地点/角色、不得直接回收伏笔。
- **失败不影响你的回合**：模型挂了或输出畸形，只是这一回合没有幕后动作。

也可以手动驱动：

```js
await eln.betweenTurns()   // 立即运行并提交一个版本
```

### 张力：导演意图与模型读数的死区

`canon.tension` 是**模型从正文里读出来的实际值**，导演另持一个 `tensionTarget` 意图值。二者之间有一个死区：

```js
// 模型的读数在目标 ±20 内 → 完全采信，导演不干预
// 超出 → 拉回带边缘，并在回合记录里说明
eln.runTurn().then(r => {
  r.turnRecord.tensionClamp   // { observed: 80, applied: 68, target: 48, band: 20 }
})

// 调旋钮（换题材或换模型时可能需要）
new ELNRuntime({ apiKey, tensionBand: 15, tensionCurve: { start: 30, end: 85 } })
```

为什么需要死区：实测中模型读数（50→60→65→75）与导演曲线（23→26→35→46）**同向但永不相交**，
偏差恒定在 30~40——因为 `tensionTarget` 只能通过 prompt 里一行提示去影响模型，闭环在那一环是断的。
死区让收敛变成可保证的，同时保留模型在合理范围内的自由（模型本就在带内时不干预）。
导演每次覆盖都会记进 `turnRecord.tensionClamp`，不静默改数。

### 连续性守卫与重写

抽取之前，引擎先检查正文与设定是否矛盾——**确定性规则为主**，不调模型：

| 规则 | 严重度 | 说明 |
|---|---|---|
| `dead_character_speaks` | error | 已死亡的角色在正文里说话 |
| `secret_leak` | error | character 模式下叙述了该角色无从知晓的秘密 |
| `unknown_speaker` | info | 出现未登记的发声者（路人合法，仅记录） |

只有 `error` 会触发一次重写，且会把**具体矛盾**带回给模型：

```js
new ELNRuntime({
  apiKey,
  maxRewrites: 1,
  // 重写会让调用方收到第二遍 token —— 必须清空缓冲重渲染
  onRewrite: ({ attempt, violations }) => {
    ui.clearCurrentTurn()
    console.warn('重写原因:', violations.map(v => v.detail))
  },
  onTurnEnd: r => {
    if (!r.continuity.ok) console.warn('仍未解决:', r.continuity.violations)
  },
})
```

> **流式 + 校验的固有代价**：token 是实时转发的，重写必然让你看到两遍正文。
> 引擎选择保留实时性，把"如何处理重写"交给 `onRewrite` 契约；
> 若改为先缓冲全文再校验，就等于放弃流式。

### 成本可观测

```js
const result = await eln.runTurn()
result.usage            // { calls, promptTokens, completionTokens, totalTokens, estimated }

eln.usage
// {
//   calls: 12, totalTokens: 8421, estimated: true,
//   byRole: { narrative: {...}, extraction: {...}, director: {...}, critic: {...} }
// }

eln.resetUsage()
```

`estimated: true` 表示至少有一项是估算的（服务商未上报，多为流式响应）。
流式请求会带 `stream_options.include_usage`，上报了就按上报值计。

### 记忆与检索

```js
eln.prose.get(3)            // 第 3 回合的正文原文
eln.prose.all()             // 全部留存正文（按回合升序）
eln.searchProse('失踪名单', { limit: 3 })   // 主动检索历史正文
```

每回合装配上下文时，引擎会按导演的 `mustAdvance` 与临期伏笔自动检索历史正文，
把相关旧事作为 `【相关旧事】` 块注入——因此很久以前埋下的细节不会因为摘要太短而消失。

### 溯源

```js
const fact = eln.getState().canon.facts.find(f => f.tags.includes('secret'))
fact.evidence   // { turn: 3, quote: '名单的事，你究竟知道多少？' }
```

每条抽取出的事实都记录它产生于第几回合、以及支撑它的原文短句。

> `intervention` 仅限导演模式。在 character 模式下请用 `action`（玩家行动）或
> `injectWorldEvent()`——后者只写事件账本，不进入任何 `Mind`，因此不会破坏认知边界。

### 伏笔与分支

```js
eln.listSeeds({ status: 'open' })   // 'open' | 'paid' | 'abandoned'
eln.getOpenSeeds()                  // 按紧迫度排序
eln.branch({ from: versionId })     // 从某版本派生新世界线
eln.checkout(versionId)             // 切回某版本（canon + minds + ledgers 一并还原）
eln.history()                       // 当前世界线的版本链
```

### 章节何时结束

引擎自己决定，不需要你调 `nextChapter()`。四个判据按顺序检查：

| 原因 | 条件 |
|---|---|
| `criteria` | 你声明的 `closeCriteria` 全部满足 |
| `threads_resolved` | **本章埋下的伏笔全部结清**（pay 或 abandon），且进度 ≥50% |
| `budget` | 回合预算耗尽 |
| `editor` | 抽取器建议收尾，且进度 ≥80% |

`threads_resolved` 是让长篇"有作者感"的那一条——读者会感到作者记得。声明更精确的条件：

```js
eln.plantSeed('那封信必须送到')
eln.setChapterCriteria({ seedsToPay: ['sd_authored_1'], goalsToMeet: ['找到失踪名单'] })

eln.getChapterCriteria()
// { closeCriteria, satisfied, missing, threads: {planted, open, resolved}, progress }
```

被彻底遗忘的伏笔不会永远卡住章节：超过 30 回合仍未回收的线会被标为 `abandoned`
（`turnRecord.abandonedSeeds` 会列出），从而不再阻挡 `threads_resolved`。

### 存档

```js
await eln.save(userId)
await eln.load(userId, worldId)
await eln.listSavedWorlds(userId)
await eln.deleteSavedWorld(userId, worldId)
await ELNRuntime.getSavedWorlds(userId, storage)   // 静态便捷方法
```

> 0.1.0 的 `save()` 在 Node 下会抛 `ReferenceError`。现在存储是适配器，默认在浏览器用
> `localStorage`、在 Node 用内存实现。要持久化到磁盘/数据库，实现 `StorageAdapter` 即可。

---

## 换用其他模型

使用 OpenAI 兼容接口，支持任意模型：

```js
// OpenAI
new ELNRuntime({ apiKey: 'sk-...', apiBase: 'https://api.openai.com/v1', model: 'gpt-4o' })

// Moonshot（Kimi）
new ELNRuntime({ apiKey: 'sk-...', apiBase: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' })

// 本地 Ollama
new ELNRuntime({ apiKey: 'ollama', apiBase: 'http://localhost:11434/v1', model: 'qwen2.5:14b' })
```

---

## 自定义存储

```js
class FileStorage {              // 实现 StorageAdapter 即可
  async get(key) { /* → string | null */ }
  async set(key, value) { /* ... */ }
  async remove(key) { /* ... */ }
  async keys() { /* → string[] */ }
}

new ELNRuntime({ apiKey, storage: new FileStorage() })
```

## 自定义检索

默认检索是零依赖的关键词 + 实体名重叠。换成向量检索只需实现 `search`：

```js
class VectorRetriever {
  attach(store) { this.store = store; return this }
  index(records) { /* 建索引 */ }
  search(query, { limit = 3, entityIds = [], excludeTurns = [] }) {
    // → [{ record: { turn, text, entityIds }, score: number }]
  }
  retrieve(query, options) { /* 可直接复用 KeywordRetriever 的形状 */ }
}

new ELNRuntime({ apiKey, retriever: new VectorRetriever() })
```

---

## 示例

- [`examples/node-basic.js`](examples/node-basic.js) — Node 最小示例（含视角、伏笔、分支、存档）
- [`examples/browser-demo.html`](examples/browser-demo.html) — 浏览器直接打开可跑的 Demo
- [ELN App demo](https://eln-app.vercel.app) — 基于本引擎构建的测试产品

---

## 测试

```bash
npm test        # node:test，全部使用 mock transport，不消耗 API 额度
```

---

## 许可证

Apache-2.0 — 商业使用友好。

---

## 贡献

欢迎 Issue 和 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

目前最欢迎的贡献：
- 英文 / 日文等风格的 style pack
- 存储与检索适配器（Redis、Postgres、Cloudflare KV、向量检索）
- 更多世界模板（genre pack）
- 不同模型的测试配置
