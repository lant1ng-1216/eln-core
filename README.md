# eln-core

**开源 AI 叙事世界引擎**

[ELN · 空镜叙事] 的核心 Runtime，已提炼为独立开源库。

```
世界状态 → Prompt工程 → 流式叙事 → 状态提取 → 循环
```

---

## 这是什么

`eln-core` 是驱动 AI 持久化故事世界的运行时引擎，负责：

- **世界生成** — 从模板或自定义描述生成世界背景、角色、章节
- **回合引擎** — 每回合流式输出叙事散文，再静默提取状态变化（情绪、信任、地点、张力）
- **角色智能体** — 每个角色拥有性格、目标、秘密和动态信任关系
- **上帝模式** — 注入事件、强制秘密揭露、给角色下达专属指令
- **快照与回溯** — 创建世界线分支，随时回溯到任意存档
- **持久化** — 存取世界存档（浏览器 localStorage 或自定义存储）

**UI 无关**。自带任意前端——对话气泡、小说阅读器、游戏地图均可。

---

## 安装

```bash
npm install @lant1ng/eln-core
```

或在浏览器中直接使用：

```html
<script type="module">
  import { ELNRuntime } from 'https://esm.sh/@lant1ng/eln-core'
</script>
```

---

## 快速上手

```js
import { ELNRuntime } from '@lant1ng/eln-core'

const eln = new ELNRuntime({
  apiKey: 'sk-你的密钥',

  // 实时接收流式 token
  onToken: token => process.stdout.write(token),

  // 每回合完成后触发
  onTurnEnd: result => {
    console.log('摘要:', result.summary)
    console.log('张力:', result.worldState.tension)
  },
})

// 1. 生成世界
const world = await eln.generateWorld('republican')  // 民国谍战
eln.loadWorld(world)

// 2. 运行一回合
await eln.runTurn()

// 3. 上帝模式：注入事件
await eln.runTurn({ intervention: '一封神秘信件突然出现在桌上' })

// 4. 强制角色透露秘密
eln.forceSecretReveal('李明远', '谢云舒')
await eln.runTurn()

// 5. 推进下一章
eln.nextChapter('聚焦两人之间的信任危机')
```

---

## 自定义世界

```js
// 方式一：使用内置模板
const world = await eln.generateWorld('ancient')

// 方式二：自由描述
const world = await eln.generateWorld(null, '三个AI科学家在火星基地，其中一个是卧底')

// 方式三：生成后手动修改角色
world.characters[0].secret = '我其实是地球派来监视你们的'
world.characters[0].goal = '在三个月内获取核心算法'
eln.loadWorld(world)
```

**内置模板：** `ancient`（古代权谋）· `republican`（民国谍战）· `mystery`（现代悬疑）· `xianxia`（架空修仙）· `campus`（校园青春）· `apocalypse`（末世求生）

---

## API 参考

### `new ELNRuntime(options)`

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | `string` | **必填** | LLM API 密钥 |
| `model` | `string` | `deepseek-chat` | 模型名称 |
| `apiBase` | `string` | `https://api.deepseek.com` | API 地址 |
| `onToken` | `(token) => void` | — | 流式 token 回调 |
| `onLine` | `(line) => void` | — | 完整行回调 |
| `onTurnEnd` | `(result) => void` | — | 回合完成回调 |

### 主要方法

```js
// 世界
await eln.generateWorld(templateKey, userPrompt)
eln.loadWorld(generatedWorld)

// 回合
await eln.runTurn({ intervention: '...' })

// 上帝模式
eln.setCharDirective(characterName, directive)
eln.forceSecretReveal(fromName, toName)
eln.nextChapter(hint)

// 快照
eln.saveSnapshot()
eln.rewindTo(index)

// 存档
eln.save(userId)
ELNRuntime.getSavedWorlds(userId)

// 状态读取
eln.getState()  // { worldState, characters, chapters, turns, snapshots }
```

---

## 换用其他模型

`eln-core` 使用 OpenAI 兼容接口，支持任意模型：

```js
// OpenAI
new ELNRuntime({ apiKey: 'sk-...', apiBase: 'https://api.openai.com', model: 'gpt-4o' })

// Moonshot（Kimi）
new ELNRuntime({ apiKey: 'sk-...', apiBase: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' })

// 本地 Ollama
new ELNRuntime({ apiKey: 'ollama', apiBase: 'http://localhost:11434/v1', model: 'qwen2.5:14b' })
```

---

## 示例

- [`examples/node-basic.js`](examples/node-basic.js) — Node.js 最小示例
- [`examples/browser-demo.html`](examples/browser-demo.html) — 浏览器直接打开的 Demo
- [ELN App demo ](https://eln-app.vercel.app) — 基于本引擎构建的测试产品

---

## 许可证

Apache-2.0 — 商业使用友好。

---

## 贡献

欢迎 Issue 和 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

目前最欢迎的贡献：
- 英文 / 日文 prompt 风格
- 其他存储适配器（Redis、Postgres、Cloudflare KV 等）
- 更多世界模板
- 不同模型的测试配置
