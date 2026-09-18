# eln-core v2 设计文档（草案 · 待评审）

> 状态：**草案，未实现**。本文档用于逐层评审，细节确认后再进入编码。
> 目标版本：`0.2.0`（破坏性升级）

---

## 0. 背景与定位

eln-core 0.1.0 是一条双调用回合链：`LLM 流式写正文 → 再调一次静默抽取 JSON 状态`。架构意识清晰（分层、UI 无关、零依赖），但存在三个结构性缺失，导致长篇质感无法提升：

| 缺失 | 现状 | 后果 |
|---|---|---|
| **没有信息差** | 所有角色的 `secret` 被拼进同一个 prompt（`prompts.js:96`） | 模型永远知道所有底牌，写不出隐瞒/试探/误会/揭露；谍战、悬疑题材的核心张力不存在 |
| **没有记忆** | 正文抽完 JSON 即丢弃，只留 `{turn, chapter, tension, summary}` 与最近 3 条摘要 | 第 3 回合的伏笔到第 20 回合在物理上已不存在；无正文即无回收 |
| **没有导演** | `tension` 由抽取器随手给且无人消费；`targetTurns`/`suggest_close_chapter` 无消费者 | 没有一层在回答"这一回合故事必须完成什么"，只有文风指令 |

此外：`trigger` 字段被硬编码为 `'ai'`（`state.js:19`）而提示词只在非 `'ai'` 时渲染它，触发器系统是死代码；角色无任何自主行为，"Agentic" 名不副实。

### 三条既定约束（决定全部取舍）

1. **形态：开源引擎 / 基础设施** — 机制必须通用、可插拔，不得为单一产品耦合；题材、语言、存储、检索、模型都必须是数据或适配器。
2. **使用者位置：导演模式与角色模式可切换** — 这要求状态模型从第一行代码起就是"客观世界 + 各主体私有视角"的双层结构，绝不可后补。
3. **优先级：文学深度优先** — 先补记忆、伏笔回收、信息不对称、抽取溯源。

### 已确认的决策

| 决策 | 结论 |
|---|---|
| 兼容性 | 直接破坏，升 `0.2.0`，不做兼容层 |
| knowledge 粒度 | 先做 holder 级粗粒度，但数据格式按事实级设计，留升级空间 |
| 依赖策略 | 允许轻量依赖（schema 校验 / 类型生成），检索与存储保持适配器 |
| 推进方式 | 先出设计文档，逐层评审，谈定后再编码 |

### 明确的代价

这不是增量优化，而是把 eln-core 从"一条调用链"重写为"有状态模型的叙事运行时"。代码量预计从 1100 行增至 3000–5000 行，`getState()` 等公共 API 结构改变，0.1.0 的使用方式基本不复存在。

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│ runtime.js          ELNRuntime 门面（唯一有状态的编排入口） │
├─────────────────────────────────────────────────────────┤
│ orchestration/      回合事务 · 导演(beat planner) · 校验自修复 │
├──────────────┬──────────────┬───────────────────────────┤
│ expression/  │ mind/        │ memory/                    │
│ prompt 组合   │ 视角投影      │ 事件账本·伏笔账本·正文·检索   │
├──────────────┴──────────────┴───────────────────────────┤
│ state/              canon · minds · ledgers · 版本与提交    │
├─────────────────────────────────────────────────────────┤
│ contracts/          schema 定义 · 校验 · 类型生成           │
├─────────────────────────────────────────────────────────┤
│ transport/          LLM 客户端（重试/超时/中止/成本路由）    │
└─────────────────────────────────────────────────────────┘
```

层间规则（沿用并强化 0.1.0 的纪律）：

- `contracts/` 与 `state/` 是纯数据，无 IO、无 fetch、无全局对象
- `transport/` 只负责收发，不含任何叙事语义
- `expression/` 只做"数据 → 字符串"，可单独快照测试（不调 LLM 即可断言 prompt 内容）
- UI 无关：`src/` 内不得出现任何渲染/交互代码

**新增的关键一层是 `mind/`（视角投影）** —— 它是"双模式可切换"的实现所在，也是本方案与 0.1.0 最大的结构差异。

---

## 2. 状态模型

### 2.1 双层结构

```
Canon（客观真相）  —— 世界里真正发生了什么，导演模式渲染全量
    ▲
    │ project(canon, holder)   ← mind/ 层的唯一职责
    │
Mind（视角）       —— 每个主体各自知道/怀疑/误信什么，角色模式渲染单份
```

核心原则：**Mind 不是 Canon 的子集，而是对 Canon 的映射，且可以包含错误。** 角色能"相信"一件假的事。误会、谎言、背叛、戏剧反讽（读者知道而角色不知道）由此自然涌现——这是文学质感的真正来源。

### 2.2 Canon

```js
Canon {
  id, version,              // 单调递增版本号，分支的基础（见 §5）
  meta: { name, tag, background, outline, createdAt },
  time, location,           // 世界时空（客观）
  tension,                  // 客观张力，由导演层驱动（不再由抽取器随手给）
  entities: Entity[],
  facts: Fact[],
  chapter: ChapterState,
}

Entity {
  id, kind: 'character' | 'place' | 'item',
  name, role, personality, goal,
  alive, emotion, weightTag, trigger, tags: string[]
}

Fact {
  id, subject, predicate, object,
  turn,                     // 产生于第几回合
  salience,                 // 叙事权重，供上下文装配排序
  tags: string[]            // 如 ['secret'] —— 秘密由此成为可查询的标签，而非角色卡上的字符串
}

ChapterState {
  index, name, goal, targetTurns, completedTurns,
  status: 'active' | 'locked' | 'done',
  beats: Beat[],
  closeCriteria: { seedsToPay?: string[], goalsToMeet?: string[] }   // 章节完成判据（见 §4）
}
```

### 2.3 Mind（本轮先做粗粒度）

```js
Mind {
  holderId,                       // 对应某个 Entity(kind:'character')
  knows:         FactRef[],       // 明确知道
  suspects:      FactRef[],       // 怀疑
  believesFalse: FactRef[],       // 误信
  trust: { [targetId]: { value: number, evidence: TurnRef[] } },  // 带溯源
}
```

**"粗粒度、留结构"的具体含义**：本轮只实现 `holder → facts` 的集合归属，不做逐条置信度推理与证据链演算；但引用一律用 `FactRef = { factId, confidence?, since?, evidence? }` 的形式，因此升级到事实级（部分知情、置信度衰减、证据链）时**不需要改数据结构，只需填充更多字段**。

**秘密的重新定义**：

```js
// 秘密不再是 c.secret 字符串，而是一次查询
secretsOf(entityId) = canon.facts.filter(f =>
  f.subject === entityId && f.tags.includes('secret'))
// "谁不知道这个秘密" = 查询各 Mind.knows 是否包含该 factId
```

这一改动让 `forceSecretReveal()` 从"往 prompt 里硬塞指令的补丁"退化为一次状态写入（把 fact 加入某 holder 的 `knows`）。**机制吃掉补丁，是架构变好的信号。**

### 2.4 事件账本

```js
Event {
  id, turn,
  kind: 'action' | 'dialogue' | 'reveal' | 'intervention' | 'offscreen' | 'world',
  actors: EntityId[], location, time, summary,
  causes: EventId[],        // 因果链：可回溯"这件事为什么发生"
  effects: EventId[],
  source: 'narrative' | 'player' | 'director' | 'agent',
}
```

`source` 字段是给 P5 角色智能体预留的接口——届时角色的回合外自主行动写入 `source:'agent'` 的事件即可，**无需改动状态模型**。这符合基础设施应有的克制：预留接口，不预先实现。

### 2.5 伏笔账本

```js
Seed {
  id, plantedTurn, text,
  kind: 'item' | 'promise' | 'identity' | 'prophecy' | 'question',
  holderIds: EntityId[],                // 谁牵涉其中
  status: 'open' | 'paid' | 'abandoned',
  payoffTurn?, payoffEventId?,
  urgency,                              // 确定性计算，见下
}
```

`urgency` 由确定性规则算出，**不问 LLM**：`urgency = f(已埋回合数, 期间被提及次数, 是否临近章节收尾)`。导演层按 urgency 排序决定本回合该回收哪条线。这是让长篇有"crafted"手感的关键——读者会感到作者记得。

### 2.6 正文留存与检索

正文不再丢弃。存储与检索都做成适配器：

```js
ProseStore { append(turn, text), get(turn), all() }

Retriever {                          // 适配器接口
  index(records),                    // records: { turn, text, entityIds[] }
  search(query, { limit, entities }): ScoredRecord[]
}
```

- **默认实现**：关键词 + 实体名命中（零外部服务）
- **可选实现**：向量检索，由使用者注入或安装独立子包

### 2.7 上下文装配（context assembly）

取代 0.1.0 的硬编码字符串拼接（`prompts.js:83-135`）。这是"prompt 即架构"的落地：

```js
assembleContext({ canon, mind, eventLedger, seedLedger, prose, retriever,
                  budget, mode: 'director' | 'character', holder })
  → { canonBlock, knowledgeBlock, memoryBlock, seedsBlock,
      interventionBlock, constraints }
```

按 token 预算裁剪，裁剪策略可插拔。装配结果是纯数据，可快照测试——**不调用 LLM 就能断言"角色 A 的上下文里不包含它不知道的秘密"**，这正是信息差能被测试的前提。

---

## 3. 视角投影（`mind/`）

```js
projectCanon(canon, mind, mode, holderId) → View
```

- **导演模式**（`mode: 'director'`）：`View = Canon` 全量，含所有秘密、所有 seed 状态、客观张力曲线
- **角色模式**（`mode: 'character'`）：`View` 仅含该 holder 的 `knows/suspects/believesFalse` 对应的 facts；未知事实以"未知"占位而非删除，以免模型产生"世界只有这些"的错觉

**双模式不是两套逻辑，是一次投影**——同一个 `projectCanon()`，只换 `holderId`。这是把"可切换"做成机制而非分支的关键。

---

## 4. 导演层与章节机制

```js
Director.plan({ view, chapter, openSeeds, minds, mode }) → BeatSpec

BeatSpec {
  mustAdvance:   EntityId[],     // 本回合必须推进谁的目标
  mustComplicate: string[],      // 必须制造的阻碍
  plantOrPay:    SeedId[],       // 必须埋下或回收的线
  tensionTarget: number,         // 本回合张力目标（沿曲线）
  hookKind: '悬念' | '反转' | '情感' | '信息',
  constraintNotes: string[],
}
```

与 0.1.0 的本质区别：0.1.0 给的是**文风指令**（"不少于 900 字""结尾留悬念钩子"），v2 给的是**戏剧指令**（"本回合必须推进 A 的目标、回收第 7 回合埋下的信、以反转收尾"）。

其中 `tensionTarget`、seed 到期、章节 turn 预算、`closeCriteria` 判定全部由**确定性规则**计算，只有 `mustComplicate` / `hookKind` 这类需要理解语义的部分才问 LLM（用便宜模型）。

章节完成由判据驱动：当 `closeCriteria` 满足（指定 seeds 已 pay、指定 goals 已达成）或 turn 预算耗尽时，引擎标记章节可收尾，**不再依赖外部手动调用 `nextChapter()`**。

---

## 5. 回合事务、版本与分支

### 5.1 一回合 = 一个事务

```
runTurn(input):
  1. assembleContext(view)              ← 按模式投影
  2. director.plan(context)             → BeatSpec
  3. narrative.stream(beatSpec, ctx)    → prose（流式回调 onToken/onLine）
  4. extract.complete(prose)            → StateDelta (JSON)
  5. validate(delta)                    ← contracts 层校验
       失败 → 携带错误信息重试一次（repair）
  6. commit(delta) → 新 canon 版本 + 新事件 + 新 seed + 正文入库
  7. 任一步失败 → 整回合回滚，标记 turn.degraded，计数器不漂移
```

这直接修掉 0.1.0 的问题：`runTurn` 抛错时 `turn` 与 `completedTurns` 已自增且无回滚，状态会累积漂移。

### 5.2 分支 = 版本引用

```js
eln.branch({ from?: versionId })   // 从某版本派生新世界线
eln.checkout(versionId)            // 切换当前世界线
```

0.1.0 的 `rewindTo()` 只是一个"先把当前状态压栈、再回溯"的只增不减的数组，与 README 承诺的"世界线分支"不符。v2 给 canon 打不可变版本号，分支即引用不同版本，语义正确且不复制冗余数据。

---

## 6. 表达层：prompt 组合

拆为可组合的 pack，全部数据驱动：

| Pack | 内容 | 例子 |
|---|---|---|
| `GenrePack` | 题材：世界观约束、文风、可用桥段 | `republican` / `xianxia` / `campus` |
| `StylePack` | 语言与文体 | `zh-literary`（中文白话）/ `zh-classical` / `en-literary` |
| `ConstraintPack` | 格式硬约束 | 对话格式、内心独白格式、字数下限 |
| `Renderers` | 把 View / ledgers 渲染成段落 | 按 `mode` 与 `holder` 裁剪 |

```js
compose(packs, context) → promptString
```

这直接修掉 `prompts.js:108` 硬编码"正在写一部多线并行的历史谍战小说"的问题——该 bug 使 `xianxia`/`campus`/`apocalypse` 等模板生成的世界被按谍战文风书写。同时让 CONTRIBUTING 中期待的"更多题材 / 英文 prompt"从**改代码**变成**加数据文件**。

---

## 7. 公共 API 草案（0.2.0）

```js
const eln = new ELNRuntime({
  apiKey,
  models: { narrative, extraction, director, critic },   // 成本路由：抽取/校验用便宜模型
  packs: [genrePack('republican'), stylePack('zh-literary')],
  retriever,                    // 可选：检索适配器
  storage,                      // 存储适配器（默认 localStorage；Node 下用内存/文件）
  mode: 'director',             // 'director' | 'character'
  playerEntityId,               // character 模式必填
  onToken, onLine, onTurnEnd, onEvent,
})

await eln.generateWorld({ genre: 'republican' })   // 或 { prompt: '三个AI科学家在火星基地' }
eln.loadWorld(world)

await eln.runTurn({ intervention? , action? })     // action 用于 character 模式
eln.getState()                                     // → { canon, minds, events, seeds, turns }
eln.getState({ perspective: holderId })            // 视角视图

eln.branch({ from });  eln.checkout(versionId)
eln.listSeeds({ status: 'open' })
```

**破坏性变更清单**（需写入 CHANGELOG 与迁移说明）：

- `getState()` 返回结构变化：`characters` → `canon.entities` + `minds`；`worldState` → `canon`
- `character.secret` 字符串不再存在，改为 `canon.facts` 查询
- `tension` 语义变化：从"抽取器给的数字"变为"导演层驱动的客观值"
- `nextChapter()` 语义变化：章节可自动收尾，手动调用降级为覆盖手段
- `rewindTo(index)` → `branch()/checkout(versionId)`
- 构造函数新增 `models` / `packs` / `mode` / `playerEntityId` / `retriever` / `storage`

---

## 8. 目录结构（目标）

```
index.js
src/
  contracts/     schema.js  validate.js  types.js → index.d.ts 生成
  state/         canon.js  mind.js  ledger.js  version.js  commit.js
  mind/          project.js                      # canon → 视角视图
  memory/        prose.js  retriever.js  keywords.js  adapters/
  orchestration/ director.js  turn.js  repair.js
  expression/    compose.js  render.js  packs/{genres,styles,constraints}/
  transport/     llm-client.js
  runtime.js
examples/
test/
```

---

## 9. 分期与验收标准

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0 地基** | canon/mind/事件账本数据结构、contracts 校验、prompt 组合层、回合事务化；修掉谍战 prompt、SSE 丢字、Node 下 `save()` ReferenceError 三个 bug | 6 种题材均生成正确文风；非法抽取被拒并可重试；回合失败后计数器不漂移；`assembleContext` 有快照测试 |
| **P1 记忆与视角** | 事件账本落地、正文留存 + 检索、`mind/project.js` 视角投影、抽取溯源（evidence） | 第 20 回合能正确引用第 3 回合的细节；**角色 A 的上下文中不含它不知道的秘密**（可断言） |
| **P2 伏笔与导演** | Seed 账本、Director/BeatSpec、tension 曲线、章节完成判据 | 埋下的 seed 在预期回合内被回收；tension 沿目标曲线推进；章节能自动收尾 |
| **P3 双模式** | player 实体、character 模式渲染、模式切换 | 同一世界切换模式，character 模式不泄露越权信息；`action` 能进入 canon |
| **P4 校验自修复** | 连续性守卫（死者不出场等确定性规则 + LLM 检查）、带错误重试、降级、成本路由 | 人工注入矛盾能被检出并打回重写；单回合成本可观测 |
| **P5 角色智能体** | `betweenTurns` hook，角色按 goal 产生 off-screen 行动写入事件账本 | 角色能在无玩家干预时主动制造事件；`source:'agent'` 事件可被导演采纳 |

P0 阶段即写入 knowledge 的数据结构（渲染可留到 P1），因为视角层不可后补。

---

## 10. 待评审时讨论的未决问题

1. **`Fact.predicate` 是否使用受控词表？** 自由文本 predicate 灵活但难检索；受控词表可检索但要维护。倾向：受控小词表 + `tags` 兜底自由文本。
2. **抽取是一次完成还是分多次？** 一次抽全部（事件 + 事实 + 知识 + seed）省调用但 schema 复杂、失败面大；分多次更可靠但成本翻倍。倾向：一次抽取 + schema 分块校验，失败时降级只保留核心字段。
3. **`tension` 的双重身份**：`canon.tension`（客观）与 Director 的 `tensionTarget`（意图）的关系——是"目标值"与"实际值"的差驱动下一回合，还是导演直接写入 canon？
4. **玩家 `action` 如何进入 canon 而不破坏导演的 beat 规划？** 玩家的自由行动可能与本回合 `mustAdvance` 冲突。
5. **`intervention`（上帝模式）在 character 模式下是否保留？** 它是导演模式的核心交互，但在角色模式下语义破坏沉浸感。
6. **依赖引入的具体清单**：建议仅 `zod`（schema 校验 + 类型生成），检索/存储一律适配器。需同步修改 `CONTRIBUTING.md` 的"不要加依赖"与 README 中"零依赖"的表述。

---

## 11. 文档同步待办

- [ ] `CONTRIBUTING.md` — 删除「Adding npm dependencies (currently zero)」，改为依赖策略说明
- [ ] `README.md` — 移除/修订"零依赖"卖点；更新 API 参考、快速上手、模板说明
- [ ] 新增 `CHANGELOG.md` — 记录 0.2.0 破坏性变更与迁移指引
- [ ] 新增 `LICENSE` — 当前声明 Apache-2.0 但仓库内无该文件
- [ ] 从版本控制移除已提交的 `.DS_Store`
- [ ] `index.js` 头注释指向的 `github.com/lant1ng-1216/eln-app` 返回 404，需确认是否公开
