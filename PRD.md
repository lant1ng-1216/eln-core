# eln-api 产品需求文档（PRD）

> 状态：**待确认**（v0.2 草案）
> 目标：把 `eln-core` 这个库做成一个托管的 API 产品
> 关联：`DESIGN.md`（引擎设计）· `CHANGELOG.md`（0.2.0）

---

## 1. 背景与目标

`eln-core` 是一个有状态模型的叙事运行时：`Canon`（客观真相）+ `Mind`（角色私有视角）+ 事件/伏笔账本 + 正文检索，一个回合是一次事务。

它现在是**一个 npm 库**：使用者要在自己的进程里 `new ELNRuntime({ apiKey })`，自己管状态、自己管模型账单。这挡住三类人：

- 前端/移动端开发者：不想在客户端持有 LLM key，也不想实现流式 + 状态同步。
- 非 JS 技术栈的团队：Python / Go / Unity 用不上。
- 非技术创作者：根本不会写代码。

**产品目标**：把运行时变成一个 HTTPS 服务，用户用一个 `worldId` 和一把 API key 就能推进故事，正文以 SSE 实时流回，token 用量自动计量计费。

**成功判据（v1）**：一个外部开发者，只读文档不读源码，能在 30 分钟内用 `curl` 跑通「建世界 → 推 3 个回合 → 取回正文」。

---

## 2. 目标用户与定位

用户群覆盖三类，但**不是三套系统**——是一套「API + 计量」基础设施的三个入口：

| 入口 | 用户 | v1 是否支持 | 差异 |
|---|---|---|---|
| 自有后端 | ELN App 自己 | ✅ | 免外部文档；走内部 key 与内部配额 |
| 开发者 API | B 端开发者 | ✅ 主力 | 公开文档、API key、SDK、配额、SLA |
| 创作者 UI | C 端非技术用户 | ⏳ 后续 | 复用同一套 API；价值在 UI，不在 API |

**结论**：v1 只建一套 API，三个入口共用。C 端的 UI 是独立产品线，不是 API 工作量。

---

## 3. 核心架构决策

### D1. 状态托管：v1 客户端持有，P2 转服务端（已定）

**v1 走无状态**：客户端持有整份 state，每回合随请求回传、拿回新 state。

**"无状态"的准确含义**：*世界状态*不托管，但服务端**仍有数据库**——账号、API key、用量、credits 账本必须落库。无状态指的是没有 `worlds` 表，不是没有 DB。

**这样选的原因**：先用最小成本验证需求，避免过早投入持久化后端与并发控制。

**迁移桥（关键设计）**：v1 就把 `worldId` 放进 URL（`/v1/worlds/:id/turns`），id 由**客户端生成**并随 state 一起携带。
P2 转托管时 **URL 与客户端代码不变**，只是服务端开始持久化、并忽略请求体里的 state。这是让 P2 不返工的核心设计。

**v1 必须接受的限制**（要写进文档，避免用户误解）：
- state 可被客户端篡改，服务端不校验其真实性。**计费仍然可信**——token 由服务端自己的 LLM 调用产生，与客户端 state 无关。
- **版本/分支（`branch`/`checkout`）会让 blob 成倍膨胀**——每个版本是一份完整快照。v1 **不开放服务端版本接口**，由客户端自行切分保存。
- **正文必须在请求里回传全量**：服务端的检索索引建立在正文之上（`KeywordRetriever` 挂在 `ProseStore` 上），剥离正文会让「第 6 回合引用第 2 回合细节」**静默失效**。`includeProse` 只能作用于**响应**方向做回声抑制。这是无状态 v1 的真实代价：每个请求都驮着整份原稿。

**P2 转托管时再补**：Postgres 持久化、Redis per-world 锁、真删除、并发控制。

### D2. 托管 key + 计量计费（已定）

平台用自己的 key 调 LLM，按 credits 向用户收费。直接复用引擎的 `UsageTracker`。

### D3. 传输层 = REST + SSE（已定）

正文 token 走 SSE 实时下发；同时支持 `Accept: application/json` 的同步返回，供服务端对服务端调用与调试。

### D4. 仓库形态：公开 monorepo（已定）

决策依据：git 仓库可见性全有或全无，与其拆仓不如**开放核心**——API 层也开源，靠托管服务变现（参考 Supabase、Cal.com）。理由是 API 层护城河薄（剥掉引擎后只剩鉴权/计量/SSE 胶水），而 monorepo 让独立开发者获得零发版延迟。

```
packages/eln-core/     ← 现有内容整体迁入（index.js, src/, test/, scripts/, examples/）
packages/eln-api/      ← 新建：无状态 API 服务
package.json           ← 新增：workspace 根
```

**迁移要点：**
- 现有文件**整体移动**到 `packages/eln-core/`，作为**一个独立提交**完成，不与功能改动混在一起。
- 发布 `@lant1ng/eln-core` 改从 `packages/eln-core` 执行（workspaces 支持），CI 发布流程需同步更新。
- 根 README 改为 monorepo 总览；`packages/eln-core/README.md` 保留现有内容；检查 `repository.url` 与文档内链接。

**风险与代价：**
- 会与外部贡献者的 fork / 未合并 PR 冲突——迁移前先合并或知会。
- 公开仓从此包含 API 层代码，**任何密钥/计费敏感配置不得入库**（全程走环境变量），需加固 `.gitignore` 与 CI。
- `packages/eln-api/package.json` 必须设 `private: true`，防止误发布到 npm。

---

## 4. API 设计

### 4.1 资源模型

```
Account ──< ApiKey
Account ──< UsageRecord / CreditLedger
              │
         worldId（客户端生成的关联键，v1 不做服务端资源）
```

v1 没有服务端的 `World` 资源——`worldId` 只是客户端自报的关联键，用于计量、统计与日志聚合。P2 起它才成为真正的服务端资源。

### 4.2 端点

| 方法 | 路径 | v1 | 说明 | 对应库方法 |
|---|---|---|---|---|
| `POST` | `/v1/worlds` | ✅ | 生成世界，返回 state blob（**不落库**） | `generateWorld` |
| **`POST`** | **`/v1/worlds/:id/turns`** | ✅ | **推进一回合（SSE）**：请求带 state，响应还新 state | `runTurn` |
| `POST` | `/v1/worlds/:id/actions` | ✅ | 上帝模式与玩家行动，返回新 state | `setCharDirective` / `forceSecretReveal` / `plantSeed` / `injectWorldEvent` / `nextChapter` |
| `GET` | `/v1/usage` | ✅ | 用量汇总（按 role / world / 时间） | `eln.usage` |
| `POST` | `/v1/keys` | ✅ | 签发 API key | — |
| `GET` | `/v1/worlds` | P2 | 列表（分页） | `listSavedWorlds` |
| `GET` | `/v1/worlds/:id` | P2 | 取状态；`?perspective=` | `getState` |
| `DELETE` | `/v1/worlds/:id` | P2 | 真删除 | `deleteSavedWorld` |
| `GET` | `/v1/worlds/:id/seeds` | P2 | 伏笔列表 | `listSeeds` |
| `GET` | `/v1/worlds/:id/prose/:turn` | P2 | 取正文 | `prose.get` |
| `GET` | `/v1/worlds/:id/versions` | P2 | 版本链 | `history` |
| `POST` | `/v1/worlds/:id/branch` | P2 | 派生世界线 | `branch` |
| `GET` | `/v1/worlds/:id/export` | P2 | 导出 state blob | `serializeState` |

> **v1 端点很少，这是无状态架构的红利**：正文、检索、伏笔、视角投影全都在客户端手里的 state 上计算，客户端直接调库即可，服务端不需要对应端点。服务端 v1 只做三件事：**生成世界、推进回合、算钱**。
>
> `actions` 用一个端点 + `type` 字段，而不是 5 个端点——它们共享同一套鉴权与计量语义。

### 4.3 回合端点（核心）

```
POST /v1/worlds/:id/turns
Authorization: Bearer eln_live_xxx
Idempotency-Key: <uuid>          # 重试安全，计费必需
Accept: text/event-stream        # 或 application/json

{
  "state": { ... },              # 客户端持有的完整 state，**必须含全部正文**（P2 起忽略）
  "action": "我撬开档案柜，翻找名单",   # character 模式
  "includeProse": false          # 仅控制**响应**是否回带正文（客户端本地已有，默认 true）
}
```

> ⚠️ **请求方向绝不能省正文**。服务端要用正文建检索索引来装配 `【相关旧事】`；一旦剥离，长期记忆能力会静默降级（不报错，只是检索不到）。`includeProse` 的收益在响应方向——客户端本地已有原文，服务端没必要再回带一遍。

SSE 事件协议：

```
event: turn.start   data: {"turn":7,"mode":"character","beatSpec":{...}}
event: token        data: {"t":"他"}
event: rewrite      data: {"attempt":1,"violations":[...]}
event: chapter.end  data: {"reason":"criteria","from":"...","to":"..."}
event: turn.end     data: {"state":{...},"summary":"...","tension":42,"usage":{...},"continuity":{...}}
event: error        data: {"code":"...","message":"..."}
```

- `turn.end` 携带**新 state**，客户端整体替换本地副本。
- 事件与引擎已有的回调一一对应（`onToken` / `onRewrite` / `onChapterEnd` / `onTurnEnd`），**API 层只做协议转换，不改引擎语义**。
- P2 起 `state` 不再出现在 `turn.end`，客户端改为轮询/按需拉取——这是唯一的客户端改动点，已记录在案。

### 4.4 统一约定

- 错误信封：`{ "error": { "code", "message", "details" } }`，HTTP 状态码规范。
- 幂等：`Idempotency-Key` 24h 内去重，避免重试导致重复计费。
- 分页：`?limit=&cursor=`。
- 所有时间 ISO-8601 UTC。
- **state 体积上限**：请求体设硬上限（数值待实测后定，先按 2MB 设），超限返回 `413`。**不要提示"关闭 `includeProse`"**——正文是必需的，此时用户只能开新世界。

---

## 5. 认证与多租户

- `Authorization: Bearer eln_live_xxx` / `eln_test_xxx`。
- key **只存哈希**（如 SHA-256 + 前缀索引），签发时明文只回显一次。
- `test` 模式走 **mock transport**（复用 `scripts/mock-server.js` 的思路）：不调真模型、不计费，用于接入联调。
- 每个 key 归属一个 `accountId`；计量与账本查询强制带 `account_id` 过滤（防越权）。
- 后续：团队/成员（v1 非目标，但表结构预留 `account_id` 层级）。

---

## 6. 计量与计费

- **数据源**：引擎每次调用已记 `byRole` 用量（narrative/extraction/director/critic/agent），区分「服务商上报」与「估算」（`estimated: true`）。
- **计量时机**：只在 `turn.end` 落账——引擎的回合本身是事务，失败即回滚，**天然不会有半截账单**。
- **计价（已定）**：抽象成 **credits**——token × 倍率 → credits，对外只暴露 credits。便于做套餐、赠送与调价而不惊动用户，也隐藏真实成本结构。预付费余额制。
- **余额不足**：回合开始前校验，不足返回 `402 Payment Required`（不要跑完才发现扣不动）。
- **风控**：单 key RPM 限流、单账号并发回合数上限、单回合 token 上限。
- **无状态下的计费可信度**：token 由服务端的 LLM 调用产生，客户端无法伪造少扣费；客户端篡改 state 只会让自己的故事变短，不构成资损。

---

## 7. 持久化与并发

### 7.1 v1（无状态）：只存账号、计量与账本

```sql
accounts(id, email, created_at)
api_keys(id, account_id, key_hash, prefix, mode, last_used_at, revoked_at)
usage_records(id, account_id, world_id, turn, role, model, prompt_tokens, completion_tokens, estimated, created_at)
credit_ledger(id, account_id, delta, reason, ref, balance_after, created_at)
```

没有 `worlds` 表。`world_id` 仅作客户端自报的关联键，用于计量与统计。

**因为没有共享可变的世界状态，v1 不需要 per-world 并发锁**，服务端可无状态水平扩容，SSE 也无需粘性会话。

### 7.2 P2（转托管）再补

```sql
worlds(id, account_id, name, genre, packs, state jsonb, state_version, rev, created_at, updated_at, deleted_at)
world_versions(id, world_id, parent_id, label, snapshot jsonb, state_version, created_at)
prose(world_id, turn, text, entity_ids)
```

- `worlds.state` 用 **JSONB** 存 `serializeState` 的产物。
- **`prose` 独立成表（已定，P2 生效）**：正文随时间膨胀，独立成表利于按回合查询与分页；内嵌 state 会导致每次读写全量、长世界 blob 过大。
  ✅ **前置约束已满足**：`serializeState` 已把 `prose` 作为独立顶层键返回，P2 拆表时直接摘出即可，v1 无需预防性改动。
- 并发：per-world 锁（`SELECT ... FOR UPDATE` 或 Redis `SET NX` + TTL），抢不到返回 `409` + `Retry-After`，**不排队**（叙事回合有状态，排队会让用户以为卡死）。写回用 `rev` 乐观锁。

### 7.3 迁移（v1 就要做）

- 序列化 state 增加 `stateVersion` 字段。
- 库侧提供 `migrateState(state)`，服务端在加载时按版本号递进迁移。
- **无状态模式下这更关键**：服务端无法"批量升级"用户手里的老 blob，只能靠版本号 + 迁移函数在每次请求时兼容。这是 v1 的硬前置。

---

## 8. 非功能需求

| 维度 | 要求 |
|---|---|
| 延迟 | 首 token < 3s（不含模型冷启动）；SSE 心跳 15s 一次防中间层断连 |
| 超时 | 单回合硬上限（如 180s），到点发 `error` 并优雅收尾 |
| 取消 | 客户端断开 → abort 底层 LLM 请求，**不计费** |
| 可观测 | 结构化日志（含 accountId、worldId、turn、role、tokens）；按 role 的 token/耗时指标 |
| 安全 | key 哈希存储；密钥走环境变量/密钥服务；入参全量 schema 校验（复用 `src/contracts/`） |
| 合规 | 无状态模式天然满足"数据可携带"；P2 起 `DELETE world` 必须真删（含版本与正文） |
| 可扩展 | 无状态服务 + 外部状态存储，可水平扩容 |

---

## 9. v1 范围与非目标

**做：**
1. 认证 + 多租户 + credits 计量计费
2. 回合 SSE 端点（无状态：请求带 state，响应还 state）+ 幂等
3. 建世界（生成）
4. actions（上帝模式 / 玩家行动）
5. 用量查询
6. test 模式（mock transport）
7. 文档 + `curl` 示例

**不做（v1）：**
- 服务端持久化世界、版本、分支、导出导入端点（P2）
- WebSocket / 双向实时推送
- 团队协作与细粒度权限
- 世界市场 / 分享
- 向量检索升级（沿用关键词检索）
- 多语言 SDK（先 TS/JS + `curl`）
- C 端 UI
- 自建模型路由/降级（先用 DeepSeek 单供应商）

---

## 10. 分期路线

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P0** | monorepo 迁移 + 库侧改造（§11 的 1–3）+ 无状态服务 + 回合 SSE | 自有后端可接入 |
| **P1** | 认证/多租户 + credits 计费 + 幂等 + test 模式 + state 版本迁移 | 可对开发者开放 |
| **P2** | 转服务端托管：PG 持久化 + 并发锁 + 版本/分支 + prose 独立表 + 导出导入 | 功能完整 v1 |
| **P3** | 限流风控 + 可观测 + 压测 + SLA | 可商用 |

---

## 11. 对 `eln-core` 库的改动清单

产品化需要库侧配合的部分（均为**向后兼容**的增量）：

1. **公开 state 导入导出** — `_snapshotState()` 目前是私有，需要公开 `exportState()` / `importState()`。P0 硬前置。
2. **`stateVersion` + `migrateState()`** — 序列化格式加版本号与迁移入口。P0 硬前置。
3. **取消支持** — `AbortSignal` 贯穿 `runTurn` → `LLMClient`，客户端断连时终止在途请求（关系到不计费）。P0 硬前置。
4. ~~`includeProse` 分流~~ — **经查证不需要库改动**：`serializeState` 已把 `prose` 作为独立顶层键返回，P2 拆表时直接摘出即可。`includeProse` 只是 API 层的响应开关。
5. **回合预算参数** — `runTurn` 接受 `maxTokens` / `timeout` 之类的上限。
6. **持久化 adapter 参考实现** — Postgres/Redis 的 `StorageAdapter` 示例（P2 用）。
7. **SSE 友好** — 现有回调已够用，需确认 `onToken` 与 abort 的交互语义。

---

## 12. 待确认的开放问题

| # | 问题 | 状态 |
|---|---|---|
| Q1 | 状态托管：v1 无状态 + P2 转托管 | ✅ 已定 |
| Q2 | 计价单位：credits | ✅ 已定 |
| Q3 | 正文存储：独立成表（P2 生效） | ✅ 已定 |
| Q4 | 仓库形态：公开 monorepo，API 层开源 | ✅ 已定 |
| Q5 | 模型供应商：先只支持 DeepSeek，还是 v1 就做多供应商？ | 倾向先单一，接口预留 |
| Q6 | 免费额度：test key 之外是否给 live 免费额度？ | 倾向给少量，便于转化 |
| Q7 | `worlds.state` 的 JSONB 体积上限与归档策略？ | P2 再定 |
| Q8 | `worldId` 由客户端生成（UUID v4）还是 v7（含时间序，利于计量聚合）？ | 倾向 v7 |

---

## 13. 附：与现有能力的关系

| PRD 章节 | 引擎已有 | 需新建 |
|---|---|---|
| 状态模型 | ✅ Canon/Mind/ledgers | — |
| 回合事务 | ✅ `commit.js` 回滚 | — |
| 计量数据 | ✅ `UsageTracker.byRole` | 计价、账本、余额 |
| 流式 | ✅ `onToken` 回调 | SSE 协议层 |
| 视角 | ✅ `projectCanon` | 无（v1 客户端本地调用） |
| 版本/分支 | ✅ `VersionStore` | 无（v1 不做服务端版本） |
| state 序列化 | ✅ `serializeState` 已存在 | 公开 API + 版本号 + 迁移 |
| 持久化 | ⚠️ 仅 localStorage/内存 | v1 只需账号/计量库；P2 需 PG |
| 认证/多租户 | ❌ | 全套 |
| 计费 | ❌ | 全套 |
