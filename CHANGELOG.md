# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] — 未发布（破坏性升级）

从"一条双调用回合链"重写为**有状态模型的叙事运行时**。设计依据见 `DESIGN.md`。
本版本**不提供兼容层**，0.1.0 的调用方式基本不再适用。

### 新增

- **双层状态模型** —— `Canon`（客观真相）与 `Mind`（各主体私有视角）。`Mind` 不是 `Canon` 的子集，
  而是可包含错误的映射，因此误会、谎言与戏剧反讽成为机制而非提示词技巧。
- **秘密即事实** —— 角色不再有 `secret` 字符串字段；秘密是带 `secret` 标签的 `Fact`，
  「谁知道这个秘密」通过查询各 `Mind` 得出。`forceSecretReveal()` 由"往提示词硬塞指令"改为一次状态写入。
- **视角投影** —— `projectCanon(canon, mind, mode, holder)`。导演模式与角色模式是**同一次投影**，
  只换 `holderId`；因此"角色 A 的上下文不含它不知道的秘密"可在**不调用 LLM** 的前提下断言。
- **事件账本** —— `Event { kind, actors, causes, effects, source }`，`source` 已为 P5 角色智能体预留
  `'agent'` 通道。
- **伏笔账本** —— `Seed`，`urgency` 由确定性规则计算（`computeUrgency`），从不询问 LLM。
- **正文留存与检索（P1）** —— `ProseStore` 保留每一回合的正文；`KeywordRetriever` 用
  CJK bigram + 实体名重叠打分。检索是适配器，可替换为向量检索。每回合按导演的
  `mustAdvance` 与临期伏笔构造查询，回捞历史正文——这是"第 6 回合仍能引用第 2 回合细节"的实现基础。
- **抽取溯源（P1）** —— `Fact.evidence = { turn, quote }`，保留支撑该事实的原文短句；
  `Mind` 的 `FactRef.evidence` 记录立场成立于哪些回合。
- **伏笔提及度接入 urgency（P1）** —— 一个反复被正文提及的伏笔，其 `urgency` 高于同期被遗忘的伏笔
  （确定性计算：年龄 + 提及次数 + 是否临近章节收尾）。
- **`plantSeed(text, options)`** —— 作者/导演主动埋线的入口，与 `setCharDirective` 同属干预手段。
- **版本快照包含正文** —— `checkout` 会一并还原该世界线的正文，不会出现"救回了世界却丢了原稿"。
- **导演层与 BeatSpec** —— 由"文风指令"升级为"戏剧指令"（本回合必须推进谁的目标、处理哪条伏笔、
  以何种钩子收束）。`tension` 采用**差驱动**：`canon.tension` 为实际值，导演持 `target`，
  二者之差沿曲线收敛。
- **章节自动收尾（P2）** —— `maybeCloseChapter()` 在每次提交后判定：`closeCriteria` 全部满足，
  或回合预算耗尽，或抽取器在章节进度 ≥80% 时建议收尾。引擎自行推进章节并写入 `world` 事件，
  手动 `nextChapter()` 降级为覆盖手段。
- **伏笔回收压力（P2）** —— 导演按 urgency 决定本回合必须回收哪些线（`plantOrPay`）；
  逾期未回收的线升级为 `constraintNotes` 中的硬性要求，并在 `overdue` 中列出。
  伏笔账本拥挤时停止新增（`plantCount` 转为 0），临近章节收尾时进一步收紧。
- **可选导演模型（P2）** —— 配置 `models.director` 后，`Director.enrich()` 会用便宜模型补上
  规则无法决定的 `mustComplicate` 与 `hookKind`。**不配置则完全走确定性规划**；
  `enrich` 任何失败都原样返回确定性 beat，不影响回合。
- **`onChapterEnd` 回调** —— 章节自动收尾时触发，参数为 `{ reason, from, to, index }`。
- **契约层（zod）** —— `contracts/schema.js` 定义全部持久化结构与抽取载荷；
  `validateExtraction()` 提供**分块校验 + 块级降级**：某块非法只废该块，不整回合回滚。
- **表达层 packs** —— `GenrePack` / `StylePack` / `ConstraintPack` 全部数据驱动。
- **版本与分支** —— `branch({ from })` / `checkout(version)`。快照覆盖 canon、minds、ledgers 与回合记录，
  分支不复制数据、不删除他人版本。
- **持久化适配器** —— `StorageAdapter` 接口 + 内存 / localStorage 实现；`memory/store.js` 负责序列化与世界列表。
- **生成 `index.d.ts` 的类型来源** —— `contracts/types.js` 的 JSDoc typedef。

### 修复

- **题材文风硬编码** —— 0.1.0 在 `prompts.js:108` 写死"多线并行的历史谍战小说"，
  导致修仙 / 校园 / 末世等模板全部被按谍战文风书写。现在文风来自 genre pack。
- **SSE 流式丢字** —— 0.1.0 对每个网络 chunk 直接 `split('\n')`，跨 chunk 的 `data:` 行
  被 `catch {}` 静默吞掉。现在 `createSSEParser` 保留跨 chunk 缓冲，只消费完整行。
- **Node 下 `save()` 抛 ReferenceError** —— 0.1.0 在 `state.js` 直接引用 `localStorage`。
  现在存储是适配器，Node 默认使用内存实现，`save()` 正常返回。
- **回合失败导致计数器漂移** —— 0.1.0 的 `turn++` / `completedTurns++` 发生在可能抛错的操作之前且无回滚。
  现在计数器在事务内推进，`applyDelta` 全程操作克隆，失败则状态原封不动。
- **`trigger` 死代码** —— 0.1.0 硬编码 `'ai'` 而渲染条件为 `!== 'ai'`，触发器系统永不生效。已移除。
- **`[DONE]` 未终止读取** —— 0.1.0 的 `break` 只跳出内层循环。
- **正文即丢即弃** —— 0.1.0 抽完 JSON 就丢弃正文，只留最近 3 条摘要；第 3 回合的伏笔到第 20 回合
  在物理上已不存在。现在正文入 `ProseStore` 并可检索。

### 变更（破坏性）

| 0.1.0 | 0.2.0 |
|---|---|
| `new ELNRuntime({ apiKey, model, apiBase })` | 新增 `models` / `packs` / `mode` / `playerEntityId` / `storage` / `retriever` |
| `getState()` → `{ worldState, characters, chapters, turns, snapshots }` | `getState()` → `{ canon, minds, events, seeds, turns }`；`getState({ perspective })` 返回视角视图 |
| `character.secret` | `canon.facts` 查询（`secretsOf(canon, entityId)`） |
| `tension` 由抽取器给出且无人消费 | 实际值 + 导演目标值，差驱动收敛 |
| `nextChapter(hint)` 手动推进 | 章节按判据自动收尾；`nextChapter()` 保留为作者的覆盖手段 |
| `saveSnapshot()` / `rewindTo(index)` | `branch({ from })` / `checkout(version)` |
| `eln.save(userId)`（同步、仅浏览器） | `await eln.save(userId)`（异步、存储适配器） |
| `ELNRuntime.getSavedWorlds(userId)` | 同上，可传入 storage；实例方法 `listSavedWorlds()` |
| 正文被丢弃 | `eln.prose` / `eln.searchProse()` 可读回任意历史回合 |
| 零依赖 | 依赖 `zod`（契约校验与类型生成） |

### 设计偏离说明

- `DESIGN.md` §2.2 草拟 `Canon.chapter: ChapterState`（单数）。一个世界包含多个章节，
  故实现为 `Canon.chapters: ChapterState[]` + `Canon.chapterIndex`。
- `DESIGN.md` §5.1 的步骤顺序把 `assembleContext` 列在 `director.plan` 之前。实现中先规划 beat
  （`director.plan` 不消费上下文块），再把 `BeatSpec` 交给 `assembleContext` 渲染，避免重复装配。
- `DESIGN.md` §10.1 的 `predicate_raw` 与 §10.2 的块级降级已按决策实现；§10.3–§10.5 的决策
  （差驱动、action 经导演复核、character 模式禁用 intervention 并提供 `injectWorldEvent()`）
  中，§10.4/§10.5 在 P3 完整落地，P0 已预置接口与错误提示。
- `DESIGN.md` §4 的 `BeatSpec` 增加了三个字段：`plantCount`（本回合是否需新埋一条线）、
  `overdue`（已逾期的伏笔 id）、`enriched`（本回合的 beat 是否经过模型补充）。前两者让
  "何时埋线 / 何时必须回收"成为数据而非隐含规则；后者便于观测成本路由是否生效。
- `Director.plan()` 保持**同步确定性**，模型参与的部分拆到 `Director.enrich()`（异步、可选）。
  §5.1 把 `director.plan` 画在回合事务的第二步，本实现把 `enrich` 放在同一位置，
  但保证它永不阻塞、永不失败。

### 尚未实现（后续阶段）

P3 双模式渲染 · P4 连续性守卫与成本路由 · P5 角色智能体。详见 `DESIGN.md` §9。
