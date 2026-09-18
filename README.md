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
| **长期记忆** | 事件账本记录"真正发生了什么"及其因果链；伏笔账本追踪埋下的线是否回收。 |
| **导演层** | 每回合先规划 `BeatSpec`：必须推进谁的目标、必须处理哪条伏笔、张力目标、收尾钩子。给的是**戏剧指令**，不是文风指令。 |
| **视角可切换** | `director`（看全量真相）与 `character`（只看该角色所知）是同一次投影，只换 `holderId`。 |
| **回合即事务** | 任一步失败则整回合回滚，计数器绝不漂移。 |

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
| `models` | `{narrative, extraction, director, critic}` | — | 分角色模型（成本路由） |
| `packs` | `Array` | `[]` | `genrePack(...)` / `stylePack(...)` / `constraintPack(...)` |
| `mode` | `'director' \| 'character'` | `director` | 视角模式 |
| `playerEntityId` | `string` | — | character 模式必填 |
| `storage` | `StorageAdapter` | 浏览器 localStorage / Node 内存 | 持久化适配器 |
| `retriever` | `Retriever` | — | 检索适配器（P1） |
| `onToken` / `onLine` | `(token) => void` | — | 流式回调 |
| `onTurnEnd` / `onEvent` | `(result) => void` | — | 回合 / 事件回调 |

### 世界与回合

```js
await eln.generateWorld({ genre, prompt })   // 生成（不自动载入）
eln.loadWorld(world)                         // 载入
await eln.runTurn({ intervention?, action? })// 推进一回合
eln.getState()                               // { canon, minds, events, seeds, turns }
eln.getState({ perspective: holderId })      // 该角色的视角视图
```

### 上帝模式

```js
eln.setCharDirective('李明远', '本回合必须怀疑谢云舒')
eln.forceSecretReveal('李明远', '谢云舒')
eln.nextChapter('聚焦两人之间的信任危机')     // 返回 false 表示故事已完结
eln.injectWorldEvent('城外传来爆炸声')        // 只改世界，不让任何角色凭空知情
```

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
