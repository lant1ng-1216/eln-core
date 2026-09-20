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
- **角色模式有限视角渲染（P3）** —— character 模式额外注入 `【叙事视角】` 块：只呈现该角色能感知的内容、
  禁止旁白揭晓他不知道的事、他人心理只能外化暗示、并按其**错误认知**书写而不替他纠正。
  仅靠过滤事实不够——模型的全知惯性会从叙述中泄露信息。
- **玩家行动经导演复核（P3）** —— `Director.reviewAction()` 在回合开始前检查硬约束
  （玩家已死亡、行动涉及已死亡的角色）。通过后行动被折进同一个 beat：玩家自己的目标排进
  `mustAdvance` 首位，行动本身成为 `constraintNotes` 中的硬性要求，而非参考建议。
- **`createPlayer(options)`（P3）** —— 创建玩家角色实体（`tags:['player']`）与配套 `Mind`，
  并与既有角色建立双向信任边。玩家只是**普通实体**，没有任何特权通道，因此不存在可泄露的越权信息。
- **`setMode()` 校验玩家实体** —— 传入未知 `playerEntityId` 时给出可操作报错并保持原模式不变。
- **玩家行动事件带 `actors`** —— 行动进入账本时记录行动者，不再是孤立事件。

### P4 校验自修复与成本可观测

- **连续性守卫（P4）** —— `ContinuityGuard` 在抽取之前检查正文。**确定性规则为主**：
  已死亡的角色说话（`dead_character_speaks`，error）、未登记的发声者（`unknown_speaker`，info）、
  有限视角叙述了该角色无从知晓的秘密（`secret_leak`，error，用 bigram 覆盖率匹配以容忍改写）。
  只有 `error` 会触发重写。
- **打回重写（P4）** —— 违反硬约束时携带**具体矛盾**重写一次（`maxRewrites`，默认 1）。
  重写后仍矛盾则照常提交（正文已存在，状态必须与之一致），但在回合记录上打
  `continuityWarnings` 并在结果中给出 `continuity.ok = false`。
- **`models.critic`（P4）** —— 可选的语义校对模型，只能**追加**发现，永远不能推翻确定性判定；
  失败或输出畸形时静默退回确定性结果。
- **成本可观测（P4）** —— `UsageTracker` 记录每次调用的 token 用量，区分"服务商上报"与"估算"
  （`estimated: true`）。`turnResult.usage` 给出单回合用量，`eln.usage` 给出累计与
  `byRole`（narrative / extraction / director / critic）分解——"抽取走便宜模型"这句成本路由的
  承诺，现在可以验证。流式请求会发送 `stream_options.include_usage`。

### P5 角色智能体

- **`CharacterAgents`** —— 角色在回合之外按自己的 `goal` 自主行动，产生的
  `source: 'agent'` / `kind: 'offscreen'` 事件写入事件账本。
  `source` 字段从 P0 就为此预留，此处兑现，**状态模型无需改动**。
- **谁行动是确定性的** —— `pickAgents()`：已死亡或无目标的角色不能行动，玩家被排除
  （玩家通过 `action` 行动），并按权重分层轮换。轮换相位与导演的 `mustAdvance` **故意错开**：
  若台前主角与幕后操盘手总是同一人，这一层就没有增量。
- **做什么需要模型** —— 一次便宜模型调用，为选中的角色各产出 1 个幕后行动。
  提示词要求行动服务于角色自身目标、不得凭空引入新地点或新角色、不得直接回收伏笔。
- **导演采纳** —— 上一回合产生的 agent 事件成为本回合 `constraintNotes` 中的义务
  （"须让此事的影响渗入场景，不必直写，但不能当作没发生过"），并记录在
  `BeatSpec.adoptedAgentEvents`。超过 1 回合的旧事件不再反复采纳。
- **`betweenTurns()`** —— 配置 `models.agent` 且 `autoAgents`（默认 true）时，回合提交后
  自动运行；也可手动调用。**任何失败都不会影响玩家的回合**，只在结果上报告。
- **`models.agent` 计入 `usage.byRole`** —— 幕后行动的 token 成本同样可观测。

### P5 的取舍说明

- 自动路径下 agent 事件不单独提交版本，而是随**下一个回合**提交（`silent` 模式）：
  幕后行动在下一场戏开场时成为既成事实。手动调用 `betweenTurns()` 会立即提交版本。
- 该层完全可选：不配置 `models.agent`，运行时行为与 P4 完全一致（有测试锁定）。

### P4 的取舍说明

- **重写会二次流式输出**。token 是实时转发给调用方的，因此重写必然让调用方看到两遍正文。
  这是流式 + 校验的固有代价：契约是 `onRewrite({ attempt, violations })`，调用方据此清空缓冲并重渲染；
  改为先缓冲全文再校验，等于用产品唯一的实时特性换取一次罕见修正。
- **`unknown_speaker` 只报 `info`**：路人性角色（"跑堂道："）是合法写法，不应强制重写。
- **`secret_leak` 用 token 覆盖率而非原文包含**判断：正文几乎不会逐字复述秘密的原句
  （秘密写作"实为地下党联络员"，正文写"他就是地下党联络员"），逐字匹配会漏判。
  覆盖率阈值 0.6，且短语短于 3 个 token 时退回逐字匹配。
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
- **抽取被 `max_tokens` 截断导致整回合状态丢失** —— 真实模型下（`scripts/verify.js` 发现）：
  抽取响应在 900 token 处被截断（`finish_reason: 'length'`），JSON 不完整，解析失败，
  整个回合**什么都没抽到**——事件、伏笔、张力全部丢失，而正文完好，所以肉眼看不出来。
  P1 给事实加上 `evidence` 原文引句后，载荷变大，撞上了 P0 定的上限。
  修法三处：上限 900 → 2000；`LLMClient.completeWithMeta()` 暴露 `finish_reason`，
  截断被识别为**截断**而非"数据畸形"；重写提示在截断时给出明确的篇幅上限
  （evidence ≤15 字、facts ≤6 条等）并加大预算。抽取提示本身也写入了篇幅上限以防患于未然。
  另：合并两次尝试时，**被截断的那次不再因为"能解析"而胜出**——已知不完整的内容不该覆盖完整的重试。
- **张力曲线对实际值没有约束力**（真实模型下测得）—— `applyDelta` 应用的是抽取值，导演的
  `tensionTarget` 只能通过 prompt 里的一行提示去影响模型，而实测中模型读数为 50→60→65→75、
  目标为 23→26→35→46：两者**同向但永不相交**，偏差恒定在 30~40。闭环在"目标→模型"这一环是断的。
  修法：`applyDelta` 增加**带约束（band）**——观测值在目标 ±`tensionBand`（默认 20）内完全采信，
  超出才被拉回带边缘；导演覆盖了模型读数时在 `turnRecord.tensionClamp` 中记录
  `{ observed, applied, target, band }`，不静默改数。
  同时把曲线量程提为配置（`tensionCurve`，默认 `{ start: 25, end: 70 }`），
  `runtime` 层可传 `tensionBand` / `tensionCurve`。
  修后实测：偏差恒 ≤20，且模型本就在带内时导演**不介入**（死区避免了无谓覆盖）。

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
- **§10.3 的补充**：原文只规定了"目标值与实际值的差驱动下一回合 target"，这在实现上留了一个开环
  ——target 对实际值没有约束力，实测无法收敛。故在 commit 侧增加 ±band 约束（见上方修复项）。
  `canon.tension` 的语义因此精确化为：**模型读数，但在导演意图的 ±band 内**。
- `DESIGN.md` §4 的 `BeatSpec` 增加了三个字段：`plantCount`（本回合是否需新埋一条线）、
  `overdue`（已逾期的伏笔 id）、`enriched`（本回合的 beat 是否经过模型补充）。前两者让
  "何时埋线 / 何时必须回收"成为数据而非隐含规则；后者便于观测成本路由是否生效。
- `Director.plan()` 保持**同步确定性**，模型参与的部分拆到 `Director.enrich()`（异步、可选）。
  §5.1 把 `director.plan` 画在回合事务的第二步，本实现把 `enrich` 放在同一位置，
  但保证它永不阻塞、永不失败。
- 决策 §10.4 写的是"违反硬约束时**改写**并回报原因"。实现选择**拒绝并回报**而非静默改写：
  擅自改掉玩家声明的行动，与"世界无视了你"在体验上无法区分，调用方也拿不到原因。
  被拒绝的行动在回合开始前抛出 `TurnFailedError`（`phase: 'action'`），状态零改动，
  调用方可用修正后的意图重试。

### 可达性修复（真实 20 回合长测驱动）

跑 20 回合长测后发现：四个"设计里写了、代码也写了，但在真实运行中**不可达**"的机制。

- **上下文预算不可达** —— `runtime.runTurn` 里硬编码 `budget: null`，`assembleContext` 的
  裁剪逻辑从公开 API 走不到。实测 20 回合上下文增长 **+497% 且无收敛迹象**（约 +205 字符/回合），
  长会话必然撞上下文窗口。修：`contextBudget` 选项（默认 16000 字符 ≈ 8k token，可传 `null` 关闭），
  裁剪按**优先级**弃车保帅——检索摘录 → 伏笔账本（保留最紧迫若干条并注明省略数）→ 事实列表 →
  剧情回顾 → 最后才动角色与世界；`trace.blockChars` / `trace.totalChars` 与
  `turnResult.promptChars` 让增长可测量。
- **增长的真实来源是导演的"全部底牌"块** —— 抽取对 `secret` 标签很宽松，该块每回合变长。
  修：只列最近 12 条，其余以"另有 N 条更早的设定未列出"收尾。修后上下文增长降到 **+125%**
  且从第 7 回合起**稳定在 ~2300 字符**（不再线性增长）。
- **判据收尾不可达** —— 没有任何非测试代码写入 `closeCriteria`，所以每次真跑都是"回合耗尽"收尾，
  P2 的招牌机制从未生效。修：新增**隐式判据**——`chapterThreads()` 判断"本章埋下的伏笔是否全部结清"，
  结清且进度 ≥50% 即可收尾（原因记为 `threads_resolved`）；另加作者 API
  `setChapterCriteria()` / `getChapterCriteria()`。为此 `ChapterState` 增加 `startedTurn`
  （默认 0：故事开始前埋的线属于第一章）。
- **`abandonSeed` 不可达** —— 无人调用，导致被遗忘的伏笔永远 `open`，既长期占着账本，
  又会让"等本章伏笔结清"的条件永不成立。修：`sweepStaleSeeds()` 在提交路径里把超过
  `ABANDON_AGE`（30 回合）仍未回收的线标为 `abandoned`，并在 `turnRecord.abandonedSeeds` 中报告。
- **抽取过度埋线** —— 实测抽取平均**每回合埋 1.8 条伏笔、只回收 1.4 条**，导致"开"恒为 ~7，
  上面那条判据永远不可达。根因是提示词写着"seeds 最多 2 条"，模型就每回合用满。
  修：提示词明确 seeds 的纪律——**大多数回合应为空**、每回合最多 1 条、并列出"什么不算伏笔"
  （角色有了新目标、气氛紧张、一般性疑问都不算），示例 JSON 里 `seeds` 直接给空数组。
  修后 20 回合共 4 条伏笔（0.2/回合），判据收尾随即生效。

修后同一脚本 20 回合：**19 通过 / 0 失败 / 1 跳过，退出码 0**。

### 已知遗留（真实长测观察到，尚未处理）

- **最后一章不会向调用方报告"故事已完结"** —— `maybeCloseChapter` 对末章返回
  `closed: false, reason: 'story complete'`，但这个原因没有进入 `turnResult`，
  调用方无法区分"章节没写完"与"已经写完了"。修法可以是给回合结果加一个显式标志。
- **实际张力停在带边缘而非收敛到曲线** —— 长测后段模型读数 88~90、曲线目标 63~64，
  band 把它压在 84（目标+20）。有界性达成，但 `canon.tension` 不会等于曲线值。
  若希望真正贴合曲线，需要缩小 band 或把曲线量程上调。

### 分期完成情况

`DESIGN.md` §9 的 P0→P5 全部实现，各阶段均有 `node:test` 覆盖（全部使用 mock transport，
不消耗 API 额度）。后续可做的方向见 §10 的延伸：向量检索适配器、受控词表扩充、
更多题材与语言 pack、更多存储后端。
