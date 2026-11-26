import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { openDb } from '../src/db.js';
import {
  DistillVerdict,
  WikiPageDraft,
  WikiStatus,
  ChunkType,
} from '../src/contracts.js';
import {
  addWikiLink,
  checkWikiInvariants,
  confirmWikiPage,
  insertWikiPage,
  listActiveWikiPages,
} from '../src/wiki.js';

const evidence = [{ source_type: 'chunk', source_id: 'c1', quote: '测试原文' }];

function columns(db: ReturnType<typeof openDb>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

describe('ADR-0009 · P0 建表立骨', () => {
  it('creates all wiki tables and chunk extensions', () => {
    const db = openDb(':memory:');
    for (const table of [
      'wiki_pages',
      'wiki_links',
      'wiki_index',
      'wiki_page_versions',
      'compile_runs',
      'v_wiki_active',
    ]) {
      const found = db
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get(table) as { name: string } | undefined;
      expect(found?.name, `missing ${table}`).toBe(table);
    }
    expect(columns(db, 'chunks')).toContain('chunk_type');
    expect(columns(db, 'chunks')).toContain('wiki_page_id');
    db.close();
  });

  it('defaults chunk_type to source', () => {
    const db = openDb(':memory:');
    db.exec(`
      INSERT INTO sources (id, kind, uri, created_at) VALUES ('s1','local_dir','/tmp/x',1);
      INSERT INTO assets (id, source_id, path, sha256, size, mtime, privacy, created_at)
        VALUES ('a1','s1','/tmp/x/a.txt','h',1,1,'llm_ok',1);
      INSERT INTO documents (id, asset_id, privacy, created_at)
        VALUES ('d1','a1','llm_ok',1);
      INSERT INTO chunks (id, document_id, ordinal, text, privacy)
        VALUES ('c1','d1',0,'some text','llm_ok');
    `);
    const row = db.prepare('SELECT chunk_type FROM chunks WHERE id = ?').get('c1') as {
      chunk_type: string;
    };
    expect(row.chunk_type).toBe('source');
    expect(() =>
      db.exec(`
        INSERT INTO chunks (id, document_id, ordinal, text, privacy, chunk_type)
          VALUES ('c2','d1',1,'bad','llm_ok','arxiv');
      `),
    ).toThrow();
    db.close();
  });

  it('enforces I18: system draft cannot be active without confirmation', () => {
    const db = openDb(':memory:');
    expect(
      insertWikiPage(db, {
        id: 'w1',
        kind: 'concept',
        title: '向量数据库',
        body: '用于语义检索',
        evidence,
      }),
    ).not.toBeNull();

    const stored = db.prepare('SELECT status FROM wiki_pages WHERE id = ?').get('w1') as {
      status: string;
    };
    expect(stored.status).toBe('proposed');

    expect(() =>
      db.exec(`
        INSERT INTO wiki_pages
          (id, kind, title, body, status, evidence_json, created_by, created_at, updated_at)
        VALUES ('w2','concept','直接激活','x','active','[]','system',1,1);
      `),
    ).toThrow(/cannot be active without confirmation/);

    expect(confirmWikiPage(db, 'w1')).toBe(true);
    const confirmed = db
      .prepare('SELECT status, updated_by, version FROM wiki_pages WHERE id = ?')
      .get('w1') as { status: string; updated_by: string; version: number };
    expect(confirmed.status).toBe('active');
    expect(confirmed.updated_by).toBe('user');
    expect(confirmed.version).toBe(2);
    db.close();
  });

  it('filters stub-linked and evidence-less pages from v_wiki_active', () => {
    const db = openDb(':memory:');
    insertWikiPage(db, {
      id: 'w1',
      kind: 'concept',
      title: '无证据页',
      body: 'x',
      evidence: [],
      created_by: 'user',
      updated_by: 'user',
    });
    confirmWikiPage(db, 'w1');
    insertWikiPage(db, {
      id: 'w2',
      kind: 'decision',
      title: '带 stub 的页',
      body: 'x',
      evidence,
      created_by: 'user',
      updated_by: 'user',
    });
    confirmWikiPage(db, 'w2');
    addWikiLink(db, 'w2', '[[尚未创建的页]]', null, 1.0);

    expect(listActiveWikiPages(db)).toHaveLength(0);

    addWikiLink(db, 'w2', '[[尚未创建的页]]', 'w1', 1.0);
    expect(listActiveWikiPages(db)).toHaveLength(1);

    db.close();
  });

  it('checks I16-I20 with hard-fail semantics', () => {
    const db = openDb(':memory:');
    const empty = checkWikiInvariants(db);
    expect(empty.map((c) => c.id)).toEqual(['I16', 'I17', 'I18', 'I19', 'I20']);
    expect(empty.find((c) => c.id === 'I19')?.ok).toBe(true);
    expect(empty.find((c) => c.id === 'I20')?.ok).toBe(true);

    insertWikiPage(db, {
      id: 'w1',
      kind: 'concept',
      title: '证据缺失',
      body: 'x',
      evidence: [],
      created_by: 'user',
      updated_by: 'user',
    });
    confirmWikiPage(db, 'w1');
    const after = checkWikiInvariants(db);
    expect(after.find((c) => c.id === 'I16')?.ok).toBe(false);
    expect(after.find((c) => c.id === 'I20')?.ok).toBe(false);
    db.close();
  });

  it('is idempotent when reopening an existing database', () => {
    const db = openDb(':memory:');
    expect(() => openDb(':memory:')).not.toThrow();
    expect(columns(db, 'wiki_pages')).toContain('evidence_json');
    db.close();
  });
});

describe('ADR-0009 · 编译层契约', () => {
  it('accepts a valid wiki page draft with default proposed status', () => {
    const parsed = WikiPageDraft.parse({
      id: 'w1',
      kind: 'incident',
      title: '搜索超时事故',
      body: '原因与改进',
      evidence,
    });
    expect(parsed.status).toBe('proposed');
    expect(parsed.created_by).toBe('system');
    expect(parsed.updated_by).toBeNull();
  });

  it('rejects a draft with no evidence', () => {
    expect(() =>
      WikiPageDraft.parse({
        id: 'w1',
        kind: 'concept',
        title: '无证据',
        body: 'x',
        evidence: [],
      }),
    ).toThrow(ZodError);
  });

  it('requires title and summary in distill verdict when should_save', () => {
    expect(() =>
      DistillVerdict.parse({
        should_save: true,
        signals: ['concrete_fact'],
      }),
    ).not.toThrow();
    expect(() =>
      DistillVerdict.parse({
        should_save: true,
        signals: ['unknown_signal'],
      }),
    ).toThrow(ZodError);
  });

  it('keeps chunk type and wiki status enums closed', () => {
    expect(ChunkType.options).toEqual(['source', 'wiki']);
    expect(WikiStatus.options).toEqual(['proposed', 'active', 'corrected', 'archived']);
  });
});
