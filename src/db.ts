import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from './sqlite.js';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  uri         TEXT NOT NULL UNIQUE,
  privacy     TEXT NOT NULL DEFAULT 'llm_ok',
  enabled     INTEGER NOT NULL DEFAULT 1,
  ignore_json TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  privacy     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ok',
  created_at  INTEGER NOT NULL,
  UNIQUE(source_id, path)
);
CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(sha256);

CREATE TABLE IF NOT EXISTS documents (
  id             TEXT PRIMARY KEY,
  asset_id       TEXT NOT NULL UNIQUE,
  title          TEXT,
  lang           TEXT,
  parse_status   TEXT NOT NULL DEFAULT 'pending',
  parse_error    TEXT,
  parser_version TEXT,
  simhash        TEXT,
  text_hash      TEXT,
  duplicate_of   TEXT,
  privacy        TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  token_count INTEGER,
  char_start  INTEGER,
  char_end    INTEGER,
  privacy     TEXT NOT NULL,
  -- ADR-0009: source = 原文切块，wiki = 编译条目（整条入向量）
  chunk_type  TEXT NOT NULL DEFAULT 'source' CHECK (chunk_type IN ('source', 'wiki')),
  wiki_page_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id, ordinal);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, text, tokenize='trigram');

CREATE TABLE IF NOT EXISTS ingest_jobs (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  locator     TEXT NOT NULL,
  sha256      TEXT,
  state       TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  started_at  INTEGER,
  finished_at INTEGER,
  UNIQUE(source_id, locator, sha256)
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS organize_suggestions (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  reason       TEXT NOT NULL,
  confidence   REAL NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  applied_value TEXT
);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON organize_suggestions(status, created_at);

-- ============ ADR-0009 · LLM Wiki 编译层（P0 建表，P1 实现编译器）============

-- wiki 页：一等实体 + 版本链（选项 B，非纯投影）
CREATE TABLE IF NOT EXISTS wiki_pages (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN
                   ('concept','project','decision','incident','howto')),
  title         TEXT NOT NULL UNIQUE,
  summary       TEXT,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
                   ('proposed','active','corrected','archived')),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source_refs   TEXT NOT NULL DEFAULT '[]',
  created_by    TEXT NOT NULL DEFAULT 'system' CHECK (created_by IN ('system','user')),
  updated_by    TEXT CHECK (updated_by IS NULL OR updated_by IN ('system','user')),
  version       INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_kind_status ON wiki_pages(kind, status);

-- 双向链接：目标页可暂不存在（stub，I17）
CREATE TABLE IF NOT EXISTS wiki_links (
  src_page_id TEXT NOT NULL,
  dst_title   TEXT NOT NULL,
  dst_page_id TEXT,
  link_type   TEXT NOT NULL DEFAULT 'reference',
  weight      REAL NOT NULL DEFAULT 1.0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (src_page_id, dst_title)
);
CREATE INDEX IF NOT EXISTS idx_wiki_links_dst ON wiki_links(dst_title, dst_page_id);

-- index.md 的结构化表示：语义导航入口
CREATE TABLE IF NOT EXISTS wiki_index (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('global','topic')),
  title      TEXT NOT NULL,
  summary    TEXT,
  page_ids   TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

-- 版本链：人编辑也写 correction 事件 + 新版本
CREATE TABLE IF NOT EXISTS wiki_page_versions (
  page_id     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  body_hash   TEXT NOT NULL,
  body        TEXT NOT NULL,
  editor      TEXT NOT NULL CHECK (editor IN ('system','user')),
  change_note TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (page_id, version)
);

-- 编译可观测
CREATE TABLE IF NOT EXISTS compile_runs (
  id            TEXT PRIMARY KEY,
  trigger       TEXT NOT NULL CHECK (trigger IN ('import','qa_distill','manual')),
  window_from   INTEGER,
  window_to     INTEGER,
  pages_created INTEGER NOT NULL DEFAULT 0,
  pages_updated INTEGER NOT NULL DEFAULT 0,
  links_added   INTEGER NOT NULL DEFAULT 0,
  index_entries INTEGER NOT NULL DEFAULT 0, -- P1 立骨：index 阶段写入条数
  generator     TEXT,                       -- 04 §5.12 约束：model@prompt_hash
  errors        TEXT,
  created_at    INTEGER NOT NULL
);

-- ============ P1 立骨（只建结构，不实现编译/编码/抽取逻辑）============

-- wiki 页全文索引：wiki-first 骨架的 FTS 代理通道；由 compiler.index 阶段同步
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts
  USING fts5(page_id UNINDEXED, title, summary, body, tokenize='trigram');

-- L2 向量落库（过渡骨架）：04 §5.7 的目标仍是 vec0，
-- 未引入 sqlite-vec 前用 BLOB 普通表承载，接口见 src/p1/vector.ts
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id   TEXT NOT NULL,
  chunk_type TEXT NOT NULL CHECK (chunk_type IN ('source', 'wiki')),
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, model)
);
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_type ON chunk_embeddings(chunk_type, model, dim);

-- L3 实体/事实骨架：字段口径对齐 04 §5.7 / §5.10（不新增同义表）
CREATE TABLE IF NOT EXISTS entities (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  etype      TEXT NOT NULL CHECK (etype IN
                 ('person','org','concept','place','project','artifact')),
  canonical  TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (name, etype)
);

CREATE TABLE IF NOT EXISTS entity_links (
  entity_id   TEXT NOT NULL REFERENCES entities(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('event','asset','memory')),
  target_id   TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (entity_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS edges (
  id         TEXT PRIMARY KEY,
  src_type   TEXT NOT NULL CHECK (src_type IN ('memory','asset','event','entity')),
  src_id     TEXT NOT NULL,
  dst_type   TEXT NOT NULL CHECK (dst_type IN ('memory','asset','event','entity')),
  dst_id     TEXT NOT NULL,
  etype      TEXT NOT NULL CHECK (etype IN
                 ('same_topic','cites','co_entity','contradicts','derived_from','related')),
  weight     REAL NOT NULL DEFAULT 1.0,
  verified   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (src_type, src_id, dst_type, dst_id, etype)
);

CREATE TABLE IF NOT EXISTS world_facts (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  predicate   TEXT NOT NULL,
  object      TEXT NOT NULL,
  valid_from  INTEGER,
  valid_to    INTEGER,
  confidence  REAL NOT NULL DEFAULT 0.5,
  evidence_id TEXT,
  origin      TEXT NOT NULL DEFAULT 'system_inferred',
  status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','retired')),
  created_at  INTEGER NOT NULL
);

-- ============ 模型调用域（04 §5.9：记账与缓存，真实接入的前置）============

CREATE TABLE IF NOT EXISTS llm_tasks (
  id             TEXT PRIMARY KEY,
  layer          TEXT NOT NULL CHECK (layer IN ('T0','T1','T1.5','T2')),
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash     TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cached         INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  latency_ms     INTEGER,
  status         TEXT NOT NULL CHECK (status IN ('ok','error','timeout','blocked')),
  error_code     TEXT,
  trace_id       TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_day ON llm_tasks(created_at);

CREATE TABLE IF NOT EXISTS llm_cache (
  input_hash     TEXT PRIMARY KEY,  -- sha256(model + prompt_version + canonical(input))
  layer          TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  output_json    TEXT NOT NULL,
  hit_count      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

-- I16 + I18 的 SQL 强制点：active 页必须有 evidence；系统生成必须经人确认
CREATE VIEW IF NOT EXISTS v_wiki_active AS
SELECT w.*
FROM wiki_pages w
WHERE w.status = 'active'
  AND json_array_length(w.evidence_json) >= 1
  AND NOT EXISTS (
    SELECT 1 FROM wiki_links l
    WHERE l.src_page_id = w.id AND l.dst_page_id IS NULL AND l.weight >= 0.4
  );

-- I18：系统生成且未经人确认（updated_by IS NULL）不得直接 active
CREATE TRIGGER IF NOT EXISTS trg_wiki_no_unconfirmed_active
BEFORE INSERT ON wiki_pages
WHEN NEW.status = 'active' AND NEW.created_by = 'system' AND NEW.updated_by IS NULL
BEGIN
  SELECT RAISE(ABORT, 'system wiki page cannot be active without confirmation');
END;
`;

function migrate(db: DatabaseSync): void {
  const sourceColumns = db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>;
  if (!sourceColumns.some((column) => column.name === 'ignore_json')) {
    db.exec('ALTER TABLE sources ADD COLUMN ignore_json TEXT');
  }

  const columns = db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'simhash')) {
    db.exec('ALTER TABLE documents ADD COLUMN simhash TEXT');
  }
  if (!columns.some((column) => column.name === 'duplicate_of')) {
    db.exec('ALTER TABLE documents ADD COLUMN duplicate_of TEXT');
  }
  const suggestionColumns = db
    .prepare('PRAGMA table_info(organize_suggestions)')
    .all() as Array<{ name: string }>;
  if (!suggestionColumns.some((column) => column.name === 'applied_value')) {
    db.exec('ALTER TABLE organize_suggestions ADD COLUMN applied_value TEXT');
  }

  // ADR-0009：老库升级补 wiki 关联列（新库已在 SCHEMA 中定义）
  const chunkColumns = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
  if (!chunkColumns.some((column) => column.name === 'chunk_type')) {
    db.exec("ALTER TABLE chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'source'");
  }
  if (!chunkColumns.some((column) => column.name === 'wiki_page_id')) {
    db.exec('ALTER TABLE chunks ADD COLUMN wiki_page_id TEXT');
  }
  // P1 立骨：老库补 compile_runs 的两列（新库已在 SCHEMA 中定义）
  const runColumns = db.prepare('PRAGMA table_info(compile_runs)').all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === 'index_entries')) {
    db.exec('ALTER TABLE compile_runs ADD COLUMN index_entries INTEGER NOT NULL DEFAULT 0');
  }
  if (!runColumns.some((column) => column.name === 'generator')) {
    db.exec('ALTER TABLE compile_runs ADD COLUMN generator TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(chunk_type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_documents_duplicate ON documents(duplicate_of)');
}

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
