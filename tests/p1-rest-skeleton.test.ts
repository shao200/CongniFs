import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { WikiPageDraft } from '../src/contracts.js';
import { addWikiLink, confirmWikiPage, insertWikiPage } from '../src/wiki.js';
import { NotImplementedError } from '../src/p1/errors.js';
import {
  stubConsistencyChecker,
  stubDistillGenerator,
  stubFactExtractor,
  stubLLM,
  stubNavScorer,
  stubTopicExtractor,
  stubVectorIndex,
} from '../src/p1/ports.js';
import { extractDrafts, generateDistillDraft, readSourceWindow } from '../src/p1/extract.js';
import { embedAndStore, vectorSearch } from '../src/p1/embed-pipeline.js';
import { extractKnowledge } from '../src/p1/knowledge-extract.js';
import { indexWikiPages } from '../src/p1/indexer.js';
import { exactTitleResolver } from '../src/p1/wiki-linker.js';
import { lintStructure, lintWiki } from '../src/p1/lint.js';
import { navigate } from '../src/p1/navigator.js';
import { computeMetrics } from '../src/p1/metrics.js';
import { evaluateGates, hardGateState } from '../src/p1/gates.js';
import { deterministicStages, runCompile } from '../src/p1/compiler.js';
import { searchWikiFirst } from '../src/p1/wiki-first.js';

const evidence = [{ source_type: 'chunk' as const, source_id: 'c1', quote: '原文证据' }];

function seedSource(db: ReturnType<typeof openDb>): void {
  db.exec(`
    INSERT INTO sources (id, kind, uri, created_at) VALUES ('s1','local_dir','/tmp/x',1);
    INSERT INTO assets (id, source_id, path, sha256, size, mtime, privacy, created_at)
      VALUES ('a1','s1','/tmp/x/a.txt','h',1,1,'llm_ok',1),
             ('a2','s1','/tmp/x/b.txt','h2',1,1,'llm_ok',1);
    INSERT INTO documents (id, asset_id, privacy, created_at) VALUES ('d1','a1','llm_ok',100);
    INSERT INTO documents (id, asset_id, privacy, created_at) VALUES ('d2','a2','llm_ok',200);
    INSERT INTO chunks (id, document_id, ordinal, text, privacy)
      VALUES ('c1','d1',0,'早期原文','llm_ok'), ('c2','d2',0,'晚期原文','llm_ok');
  `);
}

function seedActivePage(db: ReturnType<typeof openDb>, id: string, title: string): void {
  insertWikiPage(db, {
    id,
    kind: 'concept',
    title,
    body: `正文 ${title}`,
    evidence,
    created_by: 'user',
    updated_by: 'user',
  });
  confirmWikiPage(db, id);
}

describe('P1 补全骨架 · 默认端口全部未实现', () => {
  it('fails closed on every model-dependent port', async () => {
    await expect(stubLLM.complete('x')).rejects.toThrow(NotImplementedError);
    await expect(stubTopicExtractor.extract({ sources: [] })).rejects.toThrow(NotImplementedError);
    await expect(stubDistillGenerator.generate({ question: 'q', answer: 'a' }, { should_save: false, signals: [] })).rejects.toThrow(NotImplementedError);
    await expect(stubFactExtractor.extract('x')).rejects.toThrow(NotImplementedError);
    await expect(stubVectorIndex.search([1], 1)).rejects.toThrow(NotImplementedError);
    await expect(stubConsistencyChecker.check('w1')).rejects.toThrow(NotImplementedError);
    await expect(stubNavScorer.score('q', 'w1')).rejects.toThrow(NotImplementedError);
  });
});

describe('P1 补全骨架 · LLM 识别与生成编排', () => {
  it('reads a real source window before calling the extractor', async () => {
    const db = openDb(':memory:');
    seedSource(db);
    expect(readSourceWindow(db).map((chunk) => chunk.id)).toEqual(['c1', 'c2']);
    expect(readSourceWindow(db, { from: 150 }).map((chunk) => chunk.id)).toEqual(['c2']);

    const drafts = await extractDrafts(db, { from: 150 }, {
      extract: async (input) => [
        {
          id: 'w1',
          kind: 'concept',
          title: input.sources[0]?.text ?? '空',
          body: '正文',
          evidence,
        },
      ],
    });
    expect(drafts[0]?.title).toBe('晚期原文');
    await expect(extractDrafts(db)).rejects.toThrow(NotImplementedError);
    db.close();
  });

  it('forces proposed status on generated distill drafts', async () => {
    const verdict = { should_save: true, signals: ['concrete_fact', 'reusable'] as const };
    const draft = await generateDistillDraft(
      { question: 'q', answer: 'a' },
      { should_save: true, signals: [...verdict.signals] },
      {
        generate: async () => ({
          id: 'w1',
          kind: 'howto',
          title: '如何确认',
          body: '步骤',
          evidence,
          status: 'active',
        }),
      },
    );
    expect(draft?.status).toBe('proposed');
    expect(draft?.updated_by).toBeNull();
    expect(
      await generateDistillDraft(
        { question: 'q', answer: 'a' },
        { should_save: true, signals: ['concrete_fact'] },
      ),
    ).toBeNull();
  });
});

describe('P1 补全骨架 · 编码与实体抽取编排', () => {
  it('embeds through injected port and enforces I19 on write', async () => {
    const db = openDb(':memory:');
    expect(
      await embedAndStore(db, [{ chunk_id: 'c1', chunk_type: 'source', text: 'x' }], {
        model: () => 'fake-3d',
        dimension: () => 3,
        embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
      }),
    ).toBe(1);
    await expect(embedAndStore(db, [{ chunk_id: 'c2', chunk_type: 'wiki', text: 'y' }])).rejects.toThrow(
      NotImplementedError,
    );
    expect(
      await vectorSearch([0.1, 0.2, 0.3], 2, {
        search: async () => [{ chunk_id: 'c1', chunk_type: 'source' as const, score: 0.9 }],
      }),
    ).toHaveLength(1);
    db.close();
  });

  it('extracts entities and facts through injected port', async () => {
    const db = openDb(':memory:');
    const stats = await extractKnowledge(db, '原文', {
      extract: async () => ({
        entities: [{ id: 'e1', name: 'CongniFs', etype: 'project' }],
        facts: [{ id: 'f1', subject: 'CongniFs', predicate: 'is_a', object: 'RAG', evidence_id: 'c1' }],
      }),
    });
    expect(stats).toEqual({ entities: 1, facts: 1 });
    expect(db.prepare('SELECT status FROM world_facts WHERE id = ?').get('f1')).toMatchObject({
      status: 'proposed',
    });
    await expect(extractKnowledge(db, '原文')).rejects.toThrow(NotImplementedError);
    db.close();
  });
});

describe('P1 补全骨架 · index 生成与 stub 消歧', () => {
  it('writes global and topic index entries deterministically', async () => {
    const db = openDb(':memory:');
    seedSource(db);
    seedActivePage(db, 'w1', '甲页面');
    seedActivePage(db, 'w2', '乙页面');
    const pages = [
      { id: 'w2', kind: 'concept', title: '乙页面', body: '乙正文' },
      { id: 'w1', kind: 'concept', title: '甲页面', body: '甲正文' },
    ];
    expect(indexWikiPages(db, pages)).toBe(2);
    const global = db.prepare('SELECT page_ids FROM wiki_index WHERE id = ?').get('idx_global') as {
      page_ids: string;
    };
    expect(JSON.parse(global.page_ids)).toEqual(['w1', 'w2']);
    expect(searchWikiFirst(db, '甲页面', { theta_wiki: 0.1 }).wiki_hits[0]?.page_id).toBe('w1');

    addWikiLink(db, 'w1', '[[甲页面]]', null);
    expect(await exactTitleResolver(db).resolve('[[甲页面]]')).toBe('w1');
    expect(await exactTitleResolver(db).resolve('[[不存在的页]]')).toBeNull();
    db.close();
  });
});

describe('P1 补全骨架 · lint 与 navigator', () => {
  it('counts stale stubs and duplicate titles without a checker', async () => {
    const db = openDb(':memory:');
    seedSource(db);
    seedActivePage(db, 'w1', 'Foo');
    seedActivePage(db, 'w2', 'foo');
    addWikiLink(db, 'w1', '[[旧链接]]', null);
    db.prepare('UPDATE wiki_links SET created_at = ? WHERE dst_title = ?').run(
      Date.now() - 40 * 86_400_000,
      '[[旧链接]]',
    );
    const report = lintStructure(db);
    expect(report.stale_stubs).toBe(1);
    expect(report.total_links).toBe(1);
    expect(report.duplicate_titles).toBe(1);
    await expect(lintWiki(db)).rejects.toThrow(NotImplementedError);
    db.close();
  });

  it('checks consistency and navigates with injected scorers', async () => {
    const db = openDb(':memory:');
    seedSource(db);
    seedActivePage(db, 'w1', '起点');
    seedActivePage(db, 'w2', '中间');
    seedActivePage(db, 'w3', '终点');
    addWikiLink(db, 'w1', '[[中间]]', 'w2');
    addWikiLink(db, 'w2', '[[终点]]', 'w3');

    const lint = await lintWiki(db, { check: async () => ({ consistent: true, detail: 'ok' }) });
    expect(lint.inconsistent_pages).toBe(0);
    expect(lint.checked_pages).toBe(3);

    const results = await navigate(db, 'w1', 'q', 2, {
      score: async (_query, pageId) => (pageId === 'w3' ? 0.9 : 0.1),
    });
    expect(results.map((item) => item.hops).sort()).toEqual([0, 1, 2]);
    expect(results[0]?.page_id).toBe('w3');
    await expect(navigate(db, 'w1', 'q')).rejects.toThrow(NotImplementedError);
    db.close();
  });
});

describe('P1 补全骨架 · M15–M20 与闸门', () => {
  it('reports unmeasured metrics and fails gates closed on an empty db', () => {
    const db = openDb(':memory:');
    const metrics = computeMetrics(db);
    expect(metrics.map((metric) => metric.id)).toEqual(['M15', 'M16', 'M17', 'M18', 'M19', 'M20']);
    expect(metrics.every((metric) => !metric.measured)).toBe(true);
    const gates = evaluateGates(metrics);
    expect(gates.every((gate) => gate.ok === false && gate.measured === false)).toBe(true);
    expect(hardGateState(metrics)).toEqual({ violated: false, unmeasured: true, freeze: false });
    db.close();
  });

  it('computes formulas from injected inputs and distinguishes violation from unmeasured', async () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 20; i += 1) {
      seedActivePage(db, `p${i}`, `页面${i}`);
    }
    for (let i = 1; i < 20; i += 1) addWikiLink(db, 'p0', `[[页面${i}]]`, `p${i}`);
    addWikiLink(db, 'p0', '[[过期链接]]', null);
    db.prepare('UPDATE wiki_links SET created_at = ? WHERE dst_title = ?').run(
      Date.now() - 40 * 86_400_000,
      '[[过期链接]]',
    );
    const latencies = Array.from({ length: 20 }, (_, index) => (index + 1) * 1000);
    const metrics = computeMetrics(db, {
      distillation: { confirmed: 6, generated: 10 },
      retrieval: { wiki_hits: 3, total: 10 },
      navigation: { correct: 7, total: 10 },
      consistency: { checked: 20, inconsistent: 1 },
      compile_latencies_ms: latencies,
    });
    expect(metrics.find((metric) => metric.id === 'M15')?.value).toBeCloseTo(0.6);
    expect(metrics.find((metric) => metric.id === 'M19')?.value).toBeCloseTo(0.95);
    expect(metrics.find((metric) => metric.id === 'M18')?.value).toBeCloseTo(0.05);
    expect(metrics.find((metric) => metric.id === 'M20')?.value).toBe(19_000);

    const state = hardGateState(metrics);
    expect(state).toEqual({ violated: true, unmeasured: false, freeze: true });
    expect(evaluateGates(metrics).find((gate) => gate.id === 'M18')?.ok).toBe(false);
    expect(evaluateGates(metrics).find((gate) => gate.id === 'M16')?.ok).toBe(true);
    db.close();
  });

  it('runs the deterministic half of the compile pipeline', async () => {
    const db = openDb(':memory:');
    const draft = WikiPageDraft.parse({
      id: 'w1',
      kind: 'concept',
      title: '半确定性页',
      body: '正文 [[缺失页]]',
      evidence,
    });
    const result = await runCompile(db, 'manual', deterministicStages(db), {}, 'fake@hash');
    expect(result.state).toBe('failed');
    expect(result.errors[0]).toContain('TopicExtractor');

    const stages = deterministicStages(db);
    const persist = await stages.persist([draft]);
    expect(persist).toEqual({ created: 1, updated: 0 });
    expect(await stages.link([draft])).toBe(1);
    expect(await stages.index([draft])).toBe(2);
    db.close();
  });
});
