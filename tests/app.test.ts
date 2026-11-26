import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('http api', () => {
  it('reports health', async () => {
    const app = buildApp(openDb(':memory:'));
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/v1/system/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('creates a source, scans it, lists documents and searches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-api-'));
    writeFileSync(join(root, 'note.md'), '# 齿科方案\n\n种植体周围炎的治疗方案。');

    const app = buildApp(openDb(':memory:'));
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/ingest/sources',
      payload: { path: root, privacy: 'llm_ok' },
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().id as string;

    const scanned = await app.inject({
      method: 'POST',
      url: `/v1/ingest/sources/${sourceId}/scan`,
    });
    expect(scanned.statusCode).toBe(200);
    expect(scanned.json()).toMatchObject({ scanned: 1, indexed: 1, failed: 0 });

    const listed = await app.inject({ method: 'GET', url: '/v1/kb/documents' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);

    const searched = await app.inject({
      method: 'GET',
      url: '/v1/search?q=' + encodeURIComponent('种植体'),
    });
    expect(searched.statusCode).toBe(200);
    expect(searched.json().items.length).toBeGreaterThan(0);
  });

  it('hides accepted duplicates from search and document list', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-api-'));
    writeFileSync(join(root, 'a.txt'), '重复内容用于验证检索降噪。');
    writeFileSync(join(root, 'b.txt'), '重复内容用于验证检索降噪。');

    const app = buildApp(openDb(':memory:'));
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/ingest/sources',
      payload: { path: root, privacy: 'llm_ok' },
    });
    const sourceId = created.json().id as string;
    await app.inject({ method: 'POST', url: `/v1/ingest/sources/${sourceId}/scan` });

    const before = await app.inject({
      method: 'GET',
      url: '/v1/search?q=' + encodeURIComponent('重复内容'),
    });
    expect(before.json().items).toHaveLength(2);

    const suggestions = await app.inject({
      method: 'GET',
      url: '/v1/organize/suggestions?status=pending',
    });
    const suggestionId = suggestions.json().items[0].id as string;
    await app.inject({ method: 'POST', url: `/v1/organize/suggestions/${suggestionId}/accept` });

    const after = await app.inject({
      method: 'GET',
      url: '/v1/search?q=' + encodeURIComponent('重复内容'),
    });
    expect(after.json().items).toHaveLength(1);

    const visible = await app.inject({ method: 'GET', url: '/v1/kb/documents' });
    expect(visible.json().items).toHaveLength(1);

    const all = await app.inject({
      method: 'GET',
      url: '/v1/kb/documents?include_duplicates=1',
    });
    expect(all.json().items).toHaveLength(2);

    const revoked = await app.inject({
      method: 'POST',
      url: `/v1/organize/suggestions/${suggestionId}/revoke`,
    });
    expect(revoked.statusCode).toBe(200);

    const restored = await app.inject({
      method: 'GET',
      url: '/v1/search?q=' + encodeURIComponent('重复内容'),
    });
    expect(restored.json().items).toHaveLength(2);

    const restoredList = await app.inject({ method: 'GET', url: '/v1/kb/documents' });
    expect(restoredList.json().items).toHaveLength(2);
  });

  it('lists and accepts organize suggestions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-api-'));
    writeFileSync(join(root, 'a.txt'), '重复内容用于测试。');
    writeFileSync(join(root, 'b.txt'), '重复内容用于测试。');

    const app = buildApp(openDb(':memory:'));
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/ingest/sources',
      payload: { path: root, privacy: 'llm_ok' },
    });
    const sourceId = created.json().id as string;
    await app.inject({ method: 'POST', url: `/v1/ingest/sources/${sourceId}/scan` });

    const suggestions = await app.inject({
      method: 'GET',
      url: '/v1/organize/suggestions?status=pending',
    });
    expect(suggestions.statusCode).toBe(200);
    expect(suggestions.json().items).toHaveLength(1);

    const suggestionId = suggestions.json().items[0].id as string;
    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/organize/suggestions/${suggestionId}/accept`,
    });
    expect(accepted.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/v1/organize/suggestions?status=pending',
    });
    expect(after.json().items).toHaveLength(0);
  });

  it('updates ignore rules and applies them to scanning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-api-'));
    writeFileSync(join(root, 'draft.md'), '草稿内容。');
    writeFileSync(join(root, 'keep.md'), '正式内容。');

    let reloads = 0;
    const app = buildApp(openDb(':memory:'), {
      onSourceChanged: () => {
        reloads += 1;
      },
    });
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/ingest/sources',
      payload: { path: root, privacy: 'llm_ok' },
    });
    const sourceId = created.json().id as string;

    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/ingest/sources/${sourceId}/ignore`,
      payload: { ignore: ['draft*'] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().ignore).toEqual(['draft*']);
    expect(reloads).toBe(1);

    const scanned = await app.inject({
      method: 'POST',
      url: `/v1/ingest/sources/${sourceId}/scan`,
    });
    expect(scanned.json()).toMatchObject({ scanned: 1, indexed: 1 });

    const listed = await app.inject({ method: 'GET', url: '/v1/kb/documents' });
    expect(listed.json().items).toHaveLength(1);
  });
});
