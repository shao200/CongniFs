import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addSource, scanSource, updateSourceIgnore } from '../src/ingest.js';
import { isIgnored } from '../src/ignore.js';
import { startReconciler } from '../src/reconcile.js';

describe('ignore rules', () => {
  it('matches directory names, wildcards and relative paths', () => {
    expect(isIgnored('node_modules/pkg/a.txt', ['node_modules'])).toBe(true);
    expect(isIgnored('docs/draft.md', ['draft*'])).toBe(true);
    expect(isIgnored('docs/keep.md', ['draft*'])).toBe(false);
    expect(isIgnored('private/a/b.md', ['private'])).toBe(true);
    expect(isIgnored('notes/a.md', ['notes/*.md'])).toBe(true);
    expect(isIgnored('notes/2026/a.md', ['notes/*.md'])).toBe(false);
  });
});

describe('scan with custom ignore rules', () => {
  it('skips ignored files and marks previously indexed ones as ignored', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-ignore-'));
    writeFileSync(join(root, 'draft.md'), '草稿内容。');
    writeFileSync(join(root, 'keep.md'), '正式内容。');

    const db = openDb(':memory:');
    const source = addSource(db, root, 'llm_ok');
    const first = await scanSource(db, source.id);
    expect(first.indexed).toBe(2);

    updateSourceIgnore(db, source.id, ['draft*']);
    const second = await scanSource(db, source.id);
    expect(second.scanned).toBe(1);

    const statuses = db
      .prepare('SELECT status FROM assets ORDER BY path')
      .all() as Array<{ status: string }>;
    expect(statuses.map((row) => row.status)).toContain('ignored');
  });
});

describe('full reconciliation', () => {
  it('picks up files created after the last scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-reconcile-'));
    const db = openDb(':memory:');
    const source = addSource(db, root, 'llm_ok');
    const reconciler = startReconciler(db, 60 * 60 * 1000);

    try {
      writeFileSync(join(root, 'a.md'), '第一份内容。');
      await reconciler.runOnce();
      let count = db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number };
      expect(count.n).toBe(1);

      writeFileSync(join(root, 'b.md'), '第二份内容。');
      await reconciler.runOnce();
      count = db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number };
      expect(count.n).toBe(2);
    } finally {
      reconciler.stop();
    }
  });
});
