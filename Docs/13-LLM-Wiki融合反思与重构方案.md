# 13 · LLM Wiki 融合反思与重构方案

> 版本：v0.4　状态：已采纳（ADR-0009 于 2026-11-26 确认；口径已回写上游文档）　日期：2026-11-26
> 上游：`00-策划预案` v0.6、`ADR-0001`、`ADR-0008`、`ADR-0009`
> 下游：`03`/`04`/`05`/`07`/`10`/`11` 的增量修订（均已完成回写）
> 本文性质：**架构反思 + 重构施工图**。§4 的 DDL 草案已落入 04 §5.12「单一真相」，本文表格为决策留痕，施工以 04 为准。
> 变更记录：v0.2 口径回写完成（03 v0.2 / 04 v0.2 / 05 v0.2 / 07 v0.2 / 10 v0.2 / 11 v0.2）。v0.3 P1 骨架落地：编译三件套编排、L2 向量兼容层、L3 实体事实、wiki-first 路由、10 例金标集结构；业务逻辑与 M15–M20 实测仍未完成。v0.4 补齐七项剩余骨架：模型侧端口、识别/编码/抽取编排、index 生成、stub 消歧、lint/navigator、M15–M20 公式与 fail-closed 闸门。

---

## 一页纸结论

1. **要融入的不是"Wiki 功能"，是"编译层"。** CongniFs 文档宣称 L4 知识中心 RAG，代码现实只有 L1–L2（切块 + FTS5 + 去重建议）。LLM Wiki 补的正好是中间那段：把理解成本前置到导入阶段，产出可导航的页面网络。
2. **融合是双向增强，不是替换。** LLM Wiki 缺的来源追溯/冲突仲裁/人工确认，CongniFs 已有；CongniFs 缺的编译产物/导航入口/沉淀闭环，LLM Wiki 已有。
3. **决议：Wiki 页作为一等实体 + 事件溯源（ADR-0009 选项 B）**，可被人直接编辑，编辑写 correction 事件。不采用纯投影，否则丢掉"人类可纠错"这一核心价值。
4. **顺序不可颠倒**：先补 L2 向量与 L3 实体/事实，再上编译层；编译器不建在空底座上。
5. **代价说清**：人工审核是持续成本；同一 embedding 模型是硬约束（当前 bge-small-zh-v1.5 对抽象 wiki 页的表达力需在 P1 验证）；错误传播必须靠 lint + 人确认 + 版本冻结兜住。

---

## 1. 反思：三层落差

### 1.1 落差一｜文档宣称 vs 代码现实

| 文档宣称（`00`/`ADR-0008`） | 代码现实（`src/`） |
|---|---|
| 六原子、双时态、哈希链、evidence、墓碑、回执 | `events` 表仅 `id/type/payload_json/created_at` 四字段 |
| 三路召回：FTS + 向量 + 图 | 仅 FTS5（`chunks_fts`，trigram）；无向量、无图 |
| 整理面：打标/归类/去重/合并/关联/摘要/建集合 | 只有 `dedupe` 一种建议（`organize.ts`） |
| 智能面：planner/retriever/verifier/auditor | 无代理层；检索是单条 SQL（`queries.ts`） |
| 五闭环：接入·结构·整理·检索·反馈 | 接入闭环已通；结构闭环半成品；反馈闭环缺失 |

**判断**：文档跑在代码前面太远。此时叠加 LLM Wiki，若直接写编译器代码，只会制造第三层不一致。正确动作是先立口径，再按依赖顺序补代码。

### 1.2 落差二｜LLM Wiki 机制 vs CongniFs 现状

| LLM Wiki 核心机制 | CongniFs 现状 | 判定 |
|---|---|---|
| Raw / Wiki / Schema 三层分离 | 源文件只读（I14）+ 知识库 = 文档/分块；规则散在文档与 settings | **部分已有**：Raw 层扎实，Wiki 层缺一等对象，Schema 层未系统化 |
| 编译产物：概念/项目/决策/事故页 + `[[链接]]` | 只有 documents/chunks，无页面、无链接网络 | **缺失**，核心空隙 |
| `index.md` 语义导航入口（先读目录再决定查什么） | 三路召回 + RRF，无导航入口 | **缺失**，且这是解决上下文爆炸的关键 |
| 问答沉淀闭环（判定→生成→人确认→入库→复用） | 文档写了"反馈闭环"，无协议、无代码 | **缺失** |
| wiki-first 递归检索（`chunk_type=source/wiki`） | 单类型 chunks | **缺失** |
| 健康检查/lint（失效链接、过期事实、重复页面） | 每晚不变量检查（I1–I15）只查记忆 | **部分已有**，需扩展到 wiki 页 |
| 来源可追溯、冲突仲裁、人工确认、错误防护 | evidence、双时态、fail-closed、建议+人确认 | **已有且更强**，可反向输出给 LLM Wiki |

### 1.3 落差三｜架构统一点的确认

"一切皆事件，一切视图皆投影"（`00` 主张一）与 LLM Wiki 的编译产物**不冲突**：Wiki 页可以建在事件流之上，每次编辑都写 correction 事件。真正的分叉只在一点——Wiki 页是"纯投影"还是"一等实体"，这已由 ADR-0009 决议为后者。

---

## 2. 重构后的架构

编译层插入在「知识面」与「整理面」之间，不替换任何现有层：

```
接入面（已有）
  sources → assets → documents → chunks
       │
       ▼
【新】编译层 compiler
  ├─ 主题/实体识别 → wiki_pages（concept/project/decision/incident）
  ├─ [[链接]] 建边  → wiki_links（允许 stub）
  ├─ 语义导航入口   → wiki_index（index.md 的结构化表示）
  └─ chunk_type = source | wiki（同一 embedding 空间）
       │
       ▼
整理面（已有 + 增量）
  organize_suggestions（dedupe） + 【新】沉淀建议（qa_distill，保守判定）
  人确认后编译产物才 active
       │
       ▼
检索面（已有 + 增量）
  wiki-first 递归检索：先召回 wiki，分数低于阈值再召回 source
  + 现有 FTS5；向量、图按 P1/P2 补
       │
       ▼
智能面（P2）
  代理沿 wiki 链接多跳导航：先读 index，再进主题页，沿链接深入
```

**新增组件清单**：

| 组件 | 层 | 职责 | 阶段 |
|---|---|---|---|
| `compiler` | 编译 | 资料 → 页面草稿 + 链接 + 索引；增量更新 | P1 |
| `distiller` | 编译 | 问答沉淀判定（保守）+ 条目生成（标题+摘要+正文+来源） | P1 |
| `wiki-linker` | 编译 | `[[链接]]` 解析、stub 标记、失效链接巡检 | P1 |
| `wiki-lint` | 运维 | 来源校验、事实一致性、重复页、过期事实 | P2 |
| `wiki-navigator` | 检索 | 沿链接多跳导航，带 `hop` 标记 | P2 |

---

## 3. 数据流增量

### 3.1 编译流（资料入库）

```
新资料 → 识别主题/实体 → 搜索可能相关的已有页
       → 创建或更新页（草稿）→ 添加来源与 [[链接]]
       → 格式与一致性检查 → 沉淀建议 → 人确认 → active
       → 更新 wiki_index
```

失败关闭：无 evidence 的页不 `active`；`[[链接]]` 目标不存在标 stub，不静默丢弃；格式校验失败整批不入。

### 3.2 问答沉淀闭环（P1）

```
提问 → wiki-first 检索 → 生成回答
     → 沉淀判定（满足 ≥2 条：含具体事实 / 有复用价值 / 30 秒可给出结论）
     → 生成条目草稿（标题 + 摘要 + 正文 + 来源 + 链接）
     → 人确认（单键确认；拒绝需填原因，回流为负样本）
     → 双写：wiki_pages（关系库）+ wiki 向量（检索库）
     → 下次同类问题命中 wiki，跳过完整 RAG
```

关键取舍：判定 Prompt 必须保守，宁漏勿滥；让 LLM 同时输出标题与摘要，强制再做一次提炼（外部实践：准确率约 75%→88%）。**禁止自动入库**（I18）。

### 3.3 检索流（wiki-first 递归）

```
query → 先召回 chunk_type='wiki' → 相关性 ≥ 阈值？
        ├─ 是 → 直接返回 wiki 页（带来源）
        └─ 否 → 召回 chunk_type='source' 兜底
```

硬约束：wiki 与 source 必须同一 embedding 模型/维度，否则相关性不可比（I19）。

---

## 4. 数据模型增量（DDL 草案，回写 04）

```sql
-- wiki 页：一等实体 + 版本链
CREATE TABLE IF NOT EXISTS wiki_pages (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,        -- concept|project|decision|incident|howto
  title         TEXT NOT NULL UNIQUE,
  summary       TEXT,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'proposed', -- proposed|active|corrected|archived
  evidence_json TEXT NOT NULL,        -- 至少一条指向 source 的 evidence
  source_refs   TEXT,                 -- JSON: [{type,id,quote,span}]
  created_by    TEXT NOT NULL,        -- system|user
  updated_by    TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_kind_status ON wiki_pages(kind, status);

-- 双向链接：目标页可暂不存在（stub）
CREATE TABLE IF NOT EXISTS wiki_links (
  src_page_id TEXT NOT NULL,
  dst_title   TEXT NOT NULL,          -- [[标题]]
  dst_page_id TEXT,                   -- 解析成功后回填
  link_type   TEXT NOT NULL DEFAULT 'reference',
  weight      REAL NOT NULL DEFAULT 1.0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (src_page_id, dst_title)
);
CREATE INDEX IF NOT EXISTS idx_wiki_links_dst ON wiki_links(dst_title, dst_page_id);

-- index.md 的结构化表示：语义导航入口
CREATE TABLE IF NOT EXISTS wiki_index (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,           -- global|topic
  title      TEXT NOT NULL,
  summary    TEXT,
  page_ids   TEXT NOT NULL,           -- JSON 有序数组
  updated_at INTEGER NOT NULL
);

-- 版本链：人编辑也写 correction 事件 + 新版本
CREATE TABLE IF NOT EXISTS wiki_page_versions (
  page_id     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  body_hash   TEXT NOT NULL,
  body        TEXT NOT NULL,
  editor      TEXT NOT NULL,          -- system|user
  change_note TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (page_id, version)
);

-- 编译可观测
CREATE TABLE IF NOT EXISTS compile_runs (
  id            TEXT PRIMARY KEY,
  trigger       TEXT NOT NULL,        -- import|qa_distill|manual
  window_from   INTEGER,
  window_to     INTEGER,
  pages_created INTEGER NOT NULL DEFAULT 0,
  pages_updated INTEGER NOT NULL DEFAULT 0,
  links_added   INTEGER NOT NULL DEFAULT 0,
  errors        TEXT,
  created_at    INTEGER NOT NULL
);

-- chunks 增量字段（按 db.ts migrate 模式：先 PRAGMA 检查再 ALTER）
ALTER TABLE chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'source'; -- source|wiki
ALTER TABLE chunks ADD COLUMN wiki_page_id TEXT;
```

---

## 5. 不变量增量（接续 I1–I15）

| 编号 | 不变量 |
|---|---|
| I16 | `wiki_pages.status='active'` 必须有至少一条可解析 evidence（指向 source chunk 或 turn）；否则 `proposed` |
| I17 | `wiki_links.dst_page_id IS NULL` 时标记 stub，不得静默丢弃；健康检查定期尝试解析 |
| I18 | 问答沉淀产物不得自动 `active`，必须经人确认（I10 延伸） |
| I19 | `chunk_type='wiki'` 与 `'source'` 必须同一 embedding 模型与维度；不一致即拒绝写入并记 `compile_runs.errors` |
| I20 | wiki 页不得替代 source：递归检索必须保留 source 兜底路径 |

---

## 6. 评测增量（回写 10）

| 指标 | 定义 | 目标 |
|---|---|---|
| 沉淀采纳率 | 人确认的沉淀条目 / 生成的沉淀建议 | 60–70% |
| wiki 命中率 | 命中 wiki 页的查询 / 总查询 | ≥30%（P1） |
| 导航准确率 | 沿 wiki 链接多跳找到标准答案的比例 | ≥60%（P2） |
| 失效链接率 | 超 30 天未解析的 stub / 总链接 | <5% |
| wiki-source 事实一致率 | 抽检 wiki 页与 source 无矛盾的比例 | ≥90% |
| 编译延迟 | 资料入库到 wiki 页可检索 | P95 ≤60s |

硬否决：wiki-source 事实一致率 <90% 或失效链接率 >5% → 冻结编译器版本，不进入下一阶段。

---

## 7. 落地路线

| 阶段 | 动作 | 退出条件 |
|---|---|---|
| **P0 立骨**（本次） | 评审 ADR-0009 与本文；回写 03/04/05/07/10/11 口径；建表预留（先建表不实现编译器）；补 L2 向量与 L3 实体/事实 | 口径一致；表结构与 04 单一真相吻合；不变量检查覆盖 I16–I20 |
| **P1 编译 MVP** | compiler + distiller + wiki-linker；index 生成；wiki-first 递归检索 | 沉淀采纳率 ≥60%；wiki 命中率 ≥30%；编译延迟 P95 ≤60s |
| **P2 治理与导航** | wiki-navigator 多跳；wiki-lint；知识缺口清单；embedding 模型升级评估 | 导航准确率 ≥60%；事实一致率 ≥90%；失效链接率 <5% |

---

## 8. 代价与风险

| # | 代价/风险 | 具体影响 | 应对 |
|---|---|---|---|
| C1 | P0 范围进一步变大 | 编译层叠加在已滞后的 L2/L3 上 | P0 只建表与口径；编译器 P1 才开工 |
| C2 | 人工审核是持续成本 | 每次沉淀需人确认，日积月累 | 单键确认；拒绝填原因回流负样本；采纳率低于 60% 即调阈值 |
| C3 | 错误传播 | wiki 页错了会被其他页引用并放大 | evidence + 版本链 + lint + 按生成器版本冻结（复用 05 §5.3 机制） |
| C4 | 信息压缩丢失细节 | 编译摘要会筛掉未来可能重要的细节 | wiki 不替代 source，保留原文与递归兜底 |
| C5 | embedding 模型约束 | 当前 bge-small-zh-v1.5（512 维）对抽象 wiki 页的表达力未验证；换模型需重建全部向量 | P1 用金标集验证；不达标再评估 bge-m3，写 ADR |
| C6 | 长期维护成本 | 页面重复、分类混乱、链接失效、索引过大 | wiki-lint + 定期对账；把知识库当软件项目维护，而非一次性导入 |

---

## 9. 未决问题

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| Q1 | Wiki 页是否导出为 Markdown 文件（而非仅 DB） | 人类可读性、Git 版本化 | P1 只做 DB + 视图；P2 评估导出，避免双写一致性问题 |
| Q2 | 沉淀判定阈值取几信号 | 垃圾入库 vs 建不起来 | 先取"满足 ≥2 条"，用金标集校准 |
| Q3 | wiki-index 是全局单页还是按主题多页 | 大规模导航效率 | 先全局单页；页面数 >500 再按主题分 |
| Q4 | 人编辑 wiki 页时是否强制填 change_note | 审计质量 vs 摩擦 | 强制一行，与 A4 可审计一致 |
| Q5 | 编译器 prompt/模型版本如何冻结 | 错误传播防护 | 复用 05 §5.3 按生成器版本冻结机制 |

---

> 本文不改变任何已生效口径；评审通过后，增量按"单一真相"原则回写 03/04/05/07/10/11，并更新 00 文档清单。
