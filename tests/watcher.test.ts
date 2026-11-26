import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addSource } from '../src/ingest.js';
import { listDocuments } from '../src/queries.js';
import { startWatchers } from '../src/watcher.js';

async function waitFor(check: () => boolean, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('waitFor timeout');
}

describe('file watcher', () => {
  it('indexes additions and changes, and marks deletions as missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-watch-'));
    const db = openDb(':memory:');
    const source = addSource(db, root, 'llm_ok');

    const watcher = startWatchers(db, { debounceMs: 100, stabilityMs: 100 });
    try {
      await watcher.ready;

      const file = join(root, 'note.md');
      writeFileSync(file, '# 初始\n\n第一版内容。');

      await waitFor(() => {
        const row = db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number };
        return row.n === 1;
      });

      writeFileSync(file, '# 更新\n\n第二版内容。');
      await waitFor(() => {
        const rows = db.prepare('SELECT text FROM chunks').all() as Array<{ text: string }>;
        return rows.some((row) => row.text.includes('第二版内容'));
      });

      unlinkSync(file);
      await waitFor(() => {
        const row = db.prepare('SELECT status FROM assets').get() as
          | { status: string }
          | undefined;
        return row?.status === 'missing';
      });

      expect(listDocuments(db, 10, 0)).toHaveLength(0);
    } finally {
      await watcher.close();
    }
  });
});
