import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { confirmWikiPage, insertWikiPage } from '../src/wiki.js';
import { NotImplementedError } from '../src/p1/errors.js';
import { runCompile, stubStages } from '../src/p1/compiler.js';
import { distill, evaluateVerdict, stubDistiller } from '../src/p1/distiller.js';
import { linkWikiPage, parseWikiLinks, resolveStubs } from '../src/p1/wiki-linker.js';
import {
  checkEmbeddingModel,
  readEmbedding,
  searchVectors,
  stubEmbedder,
  upsertEmbeddings,
} from '../src/p1/vector.js';
import { insertFact, listEntities, listFacts, linkEntity, upsertEntity } from '../src/p1/knowledge.js';
import { indexWikiPageForSearch, searchWikiFirst } from '../src/p1/wiki-first.js';
import type { CompileStages, Distiller } from '../src/p1/contracts.js';

const evidence = [{ source_type: 'chunk' as const, source_id: 'c1', quote: '原文证据' }];

describe('P1 立骨 · 表结构', () => {
  it('creates L2/L3 skeleton tables and compile_runs extensions', () => {
    const db = openDb(':memory:');
    for (const table of [
      'wiki_pages_fts',
      'chunk_embeddings',
      'entities',
      'entity_links',
      'edges',
      'world_facts',
    ]) {
      const found = db
        .prepare('SELECT name FROM sqlite_master WHERE name = ?')
        .get(table) as { name: string } | undefined;
      expect(found?.name, `missing ${table}`).toBe(table);
    }
    const columns = (db.prepare('PRAGMA table_info(compile_runs)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(columns).toContain('index_entries');
    expect(columns).toContain('generator');
    db.close();
  });
});

describe('P1 立骨 · 编译编排', () => {
  it('fails closed and records errors when default stages are unimplemented', async () => {
    const db = openDb(':memory:');
    const result = await runCompile(db, 'import', stubStages(), {}, 'm@prompt-hash');
    expect(result.state).toBe('failed');
    expect(result.errors[0]).toContain('[P1 骨架]');
    const row = db
      .prepare('SELECT errors, generator FROM compile_runs WHERE id = ?')
      .get(result.run_id) as { errors: string; generator: string };
    expect(row.generator).toBe('m@prompt-hash');
    expect(JSON.parse(row.errors)[0]).toContain('尚未实现');
    db.close();
  });

  it('records stage statistics when injected stages run', async () => {
    const db = openDb(':memory:');
    const stages: CompileStages = {
      draft: async () => [],
      persist: async () => ({ created: 2, updated: 1 }),
      link: async () => 3,
      index: async () => 4,
    };
    const result = await runCompile(db, 'manual', stages);
    expect(result).toMatchObject({
      state: 'done',
      pages_created: 2,
      pages_updated: 1,
      links_added: 3,
      index_entries: 4,
      errors: [],
    });
    db.close();
  });
});

describe('P1 立骨 · 沉淀判定', () => {
  it('requires at least two signals', () => {
    expect(evaluateVerdict({ should_save: true, signals: ['concrete_fact'] })).toBe(false);
    expect(
      evaluateVerdict({ should_save: true, signals: ['concrete_fact', 'reusable'] }),
    ).toBe(true);
    expect(evaluateVerdict({ should_save: false, signals: ['concrete_fact', 'reusable'] })).toBe(
      false,
    );
  });

  it('forces proposed status and rejects drafts without evidence', async () => {
    const distiller: Distiller = {
      judge: async () => ({
        should_save: true,
        title_suggestion: '向量数据库',
        summary: '用于语义检索',
        signals: ['concrete_fact', 'reusable'],
      }),
      draft: async () => ({
        id: 'w1',
        kind: 'concept',
        title: '向量数据库',
        body: '用于语义检索',
        evidence,
      }),
    };
    const draft = await distill({ question: 'q', answer: 'a' }, distiller);
    expect(draft?.status).toBe('proposed');
    expect(draft?.updated_by).toBeNull();

    const bad: Distiller = {
      ...distiller,
      draft: async () => ({
        id: 'w2',
        kind: 'concept',
        title: '无证据',
        body: 'x',
        evidence: [],
      }),
    };
    await expect(distill({ question: 'q', answer: 'a' }, bad)).rejects.toThrow();
    await expect(distill({ question: 'q', answer: 'a' }, stubDistiller)).rejects.toThrow(
      NotImplementedError,
    );
  });
});

describe('P1 立骨 · wiki-linker', () => {
  it('parses wiki links with line numbers', () => {
    const tokens = parseWikiLinks('开头 [[概念]]\n第二 [[项目]] 与 [[概念]]');
    expect(tokens.map((token) => token.title)).toEqual(['概念', '项目', '概念']);
    expect(tokens[1]?.line).toBe(2);
  });

  it('keeps stubs and supports injected resolution', async () => {
    const db = openDb(':memory:');
    insertWikiPage(db, {
      id: 'w1',
      kind: 'concept',
      title: '概念页',
      body: 'x',
      evidence,
    });
    expect(linkWikiPage(db, 'w1', parseWikiLinks('[[概念页]] [[未创建]]'))).toBe(2);
    const stubs = db
      .prepare('SELECT COUNT(*) AS n FROM wiki_links WHERE dst_page_id IS NULL')
      .get() as { n: number };
    expect(stubs.n).toBe(2);

    const resolved = await resolveStubs(db, {
      resolve: async (title) => (title === '[[概念页]]' ? 'w1' : null),
    });
    expect(resolved).toBe(1);
    await expect(resolveStubs(db)).rejects.toThrow(NotImplementedError);
    db.close();
  });
});

describe('P1 立骨 · L2 向量与 L3 实体事实', () => {
  it('enforces I19 model/dimension consistency', async () => {
    const db = openDb(':memory:');
    upsertEmbeddings(db, [
      { chunk_id: 'c1', chunk_type: 'source', model: 'm1', dim: 3, vector: [0.1, 0.2, 0.3] },
    ]);
    expect(readEmbedding(db, 'c1', 'm1')).toHaveLength(3);
    expect(checkEmbeddingModel(db, 'm1', 3).ok).toBe(true);
    expect(checkEmbeddingModel(db, 'm2', 3).ok).toBe(false);
    expect(() =>
      upsertEmbeddings(db, [
        { chunk_id: 'c2', chunk_type: 'wiki', model: 'm2', dim: 3, vector: [1, 2, 3] },
      ]),
    ).toThrow(/I19/);
    expect(() =>
      upsertEmbeddings(db, [
        { chunk_id: 'c3', chunk_type: 'source', model: 'm1', dim: 3, vector: [1, 2] },
      ]),
    ).toThrow(/维度不符/);
    expect(() => searchVectors(db, [1, 2, 3], 5)).toThrow(NotImplementedError);
    await expect(stubEmbedder.embed(['x'])).rejects.toThrow(NotImplementedError);
    expect(stubEmbedder.dimension()).toBe(512);
    db.close();
  });

  it('writes entities and facts with proposed status', () => {
    const db = openDb(':memory:');
    upsertEntity(db, { id: 'e1', name: 'CongniFs', etype: 'project', canonical: 'CongniFs' });
    upsertEntity(db, { id: 'e2', name: 'CongniFs', etype: 'project', canonical: '知识中心 RAG' });
    expect(listEntities(db)).toHaveLength(1);
    linkEntity(db, 'e1', 'asset', 'a1');
    insertFact(db, {
      id: 'f1',
      subject: 'CongniFs',
      predicate: 'is_a',
      object: '知识中心 RAG',
      evidence_id: 'c1',
    });
    expect(listFacts(db, 'CongniFs')[0]?.status).toBe('proposed');
    expect(listFacts(db, '不存在的实体')).toHaveLength(0);
    db.close();
  });
});

describe('P1 立骨 · wiki-first 路由', () => {
  it('routes to wiki above threshold and falls back to source below it', () => {
    const db = openDb(':memory:');
    db.exec(`
      INSERT INTO sources (id, kind, uri, created_at) VALUES ('s1','local_dir','/tmp/x',1);
      INSERT INTO assets (id, source_id, path, sha256, size, mtime, privacy, created_at)
        VALUES ('a1','s1','/tmp/x/a.txt','h',1,1,'llm_ok',1);
      INSERT INTO documents (id, asset_id, privacy, created_at) VALUES ('d1','a1','llm_ok',1);
      INSERT INTO chunks (id, document_id, ordinal, text, privacy)
        VALUES ('c1','d1',0,'向量数据库用于语义检索','llm_ok');
      INSERT INTO chunks_fts (chunk_id, text) VALUES ('c1','向量数据库用于语义检索');
    `);
    insertWikiPage(db, {
      id: 'w1',
      kind: 'concept',
      title: '向量数据库',
      summary: '语义检索',
      body: '用于语义检索',
      evidence,
      created_by: 'user',
      updated_by: 'user',
    });
    confirmWikiPage(db, 'w1');
    indexWikiPageForSearch(db, {
      id: 'w1',
      title: '向量数据库',
      summary: '语义检索',
      body: '用于语义检索',
    });

    const wiki = searchWikiFirst(db, '向量数据库', { theta_wiki: 0.1 });
    expect(wiki.path).toBe('wiki');
    expect(wiki.wiki_hits[0]?.page_id).toBe('w1');

    const source = searchWikiFirst(db, '向量数据库', { theta_wiki: 0.6 });
    expect(source.path).toBe('source');
    expect(source.source_hits[0]?.id).toBe('c1');
    expect(source.reason).toContain('回落 source');

    expect(() => searchWikiFirst(db, '向量数据库', { score_mode: 'vector' })).toThrow(
      NotImplementedError,
    );
    db.close();
  });
});

describe('P1 立骨 · 金标集骨架', () => {
  it('loads exactly 10 structured cases', () => {
    const golden = JSON.parse(
      readFileSync(new URL('../tests/fixtures/p1-golden-10.json', import.meta.url), 'utf8'),
    ) as { cases: Array<{ id: string; status: string; expected: { route: string } }> };
    expect(golden.cases).toHaveLength(10);
    expect(new Set(golden.cases.map((item) => item.id)).size).toBe(10);
    expect(golden.cases.every((item) => item.status === 'pending')).toBe(true);
    expect(golden.cases.every((item) => ['wiki', 'source'].includes(item.expected.route))).toBe(
      true,
    );
  });
});
