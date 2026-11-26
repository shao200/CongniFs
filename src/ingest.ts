import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from './sqlite.js';
import type { Privacy } from './contracts.js';
import { recordDedupeSuggestions, simhash64 } from './dedupe.js';
import { DEFAULT_IGNORES, isIgnored, parseIgnore } from './ignore.js';
import { parseFileSafely } from './parse-sandbox.js';
import { SUPPORTED_EXTENSIONS } from './parse.js';
import { withTx } from './db.js';

const IGNORED = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.DS_Store',
  '$RECYCLE.BIN',
  'System Volume Information',
]);

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface SourceRow {
  id: string;
  kind: string;
  uri: string;
  privacy: Privacy;
  enabled: number;
  ignore_json: string | null;
  created_at: number;
}

export interface TextChunk {
  text: string;
  start: number;
  end: number;
}

export interface ScanResult {
  sourceId: string;
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
}

export function addSource(db: DatabaseSync, path: string, privacy: Privacy): SourceRow {
  const uri = resolve(path);
  if (!existsSync(uri) || !statSync(uri).isDirectory()) {
    throw new Error(`NOT_A_DIRECTORY: ${uri}`);
  }
  const existing = db.prepare('SELECT * FROM sources WHERE uri = ?').get(uri) as SourceRow | undefined;
  if (existing) return existing;

  const row: SourceRow = {
    id: randomUUID(),
    kind: 'local_dir',
    uri,
    privacy,
    enabled: 1,
    ignore_json: null,
    created_at: Date.now(),
  };
  db.prepare(
    'INSERT INTO sources (id, kind, uri, privacy, enabled, ignore_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.kind, row.uri, row.privacy, row.enabled, row.ignore_json, row.created_at);
  return row;
}

export function updateSourceIgnore(
  db: DatabaseSync,
  id: string,
  patterns: string[],
): SourceRow | undefined {
  const result = db
    .prepare('UPDATE sources SET ignore_json = ? WHERE id = ?')
    .run(JSON.stringify(patterns), id);
  if (result.changes === 0) return undefined;
  return getSource(db, id);
}

export function getSource(db: DatabaseSync, id: string): SourceRow | undefined {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
}

function walk(root: string, patterns: string[]): string[] {
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (isIgnored(relative(root, path), patterns)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        out.push(path);
      }
    }
  };
  visit(root);
  return out;
}

export function chunkText(input: string, maxChars = 800): TextChunk[] {
  const text = input.replace(/\r\n/g, '\n');
  const paragraphs: TextChunk[] = [];
  let cursor = 0;
  for (const raw of text.split(/\n{2,}/)) {
    const value = raw.trim();
    const start = value ? text.indexOf(value, cursor) : -1;
    if (value && start >= 0) {
      paragraphs.push({ text: value, start, end: start + value.length });
      cursor = start + raw.length + 2;
    } else {
      cursor += raw.length + 2;
    }
  }

  const chunks: TextChunk[] = [];
  let buffer: TextChunk | undefined;
  const flush = () => {
    if (buffer) {
      chunks.push(buffer);
      buffer = undefined;
    }
  };

  for (const paragraph of paragraphs) {
    if (paragraph.text.length > maxChars) {
      flush();
      const overlap = Math.floor(maxChars * 0.15);
      for (let offset = 0; offset < paragraph.text.length; offset += maxChars - overlap) {
        const slice = paragraph.text.slice(offset, offset + maxChars);
        chunks.push({
          text: slice,
          start: paragraph.start + offset,
          end: paragraph.start + offset + slice.length,
        });
      }
      continue;
    }

    if (buffer && buffer.text.length + paragraph.text.length + 2 > maxChars) {
      flush();
    }
    if (!buffer) {
      buffer = { text: paragraph.text, start: paragraph.start, end: paragraph.end };
    } else {
      buffer = {
        text: `${buffer.text}\n\n${paragraph.text}`,
        start: buffer.start,
        end: paragraph.end,
      };
    }
  }
  flush();
  return chunks;
}

function titleOf(path: string, text: string): string {
  const heading = text.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return basename(path, extname(path));
}

function deleteDerived(db: DatabaseSync, assetId: string): void {
  const doc = db.prepare('SELECT id FROM documents WHERE asset_id = ?').get(assetId) as
    | { id: string }
    | undefined;
  if (!doc) return;
  db.prepare(
    'DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)',
  ).run(doc.id);
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(doc.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
}

async function indexFile(
  db: DatabaseSync,
  source: SourceRow,
  path: string,
): Promise<'indexed' | 'skipped'> {
  const stat = statSync(path);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('TOO_LARGE');
  }

  const ext = extname(path).toLowerCase();
  const content = readFileSync(path);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const existing = db
    .prepare('SELECT * FROM assets WHERE source_id = ? AND path = ?')
    .get(source.id, path) as { id: string; sha256: string } | undefined;

  if (existing?.sha256 === sha256) {
    const doc = db
      .prepare("SELECT parse_status FROM documents WHERE asset_id = ?")
      .get(existing.id) as { parse_status: string } | undefined;
    if (doc?.parse_status === 'ok') return 'skipped';
  }

  const parsed = await parseFileSafely(path, ext, content);
  const extracted = parsed.text.trim();
  if (!extracted) throw new Error('EMPTY');
  const chunks = chunkText(extracted);
  if (chunks.length === 0) throw new Error('EMPTY');
  const simhashValue = simhash64(extracted);

  return withTx(db, () => {
    let assetId = existing?.id;
    if (existing) {
      db.prepare(
        'UPDATE assets SET sha256 = ?, size = ?, mtime = ?, privacy = ?, status = ? WHERE id = ?',
      ).run(sha256, stat.size, Math.floor(stat.mtimeMs), source.privacy, 'ok', existing.id);
      deleteDerived(db, existing.id);
    } else {
      assetId = randomUUID();
      db.prepare(
        'INSERT INTO assets (id, source_id, path, sha256, size, mtime, privacy, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        assetId,
        source.id,
        path,
        sha256,
        stat.size,
        Math.floor(stat.mtimeMs),
        source.privacy,
        'ok',
        Date.now(),
      );
    }

    const documentId = randomUUID();
    db.prepare(
      "INSERT INTO documents (id, asset_id, title, parse_status, parser_version, simhash, text_hash, privacy, created_at) VALUES (?, ?, ?, 'ok', ?, ?, ?, ?, ?)",
    ).run(
      documentId,
      assetId!,
      titleOf(path, extracted),
      parsed.parserVersion,
      simhashValue.toString(),
      sha256,
      source.privacy,
      Date.now(),
    );

    const insertChunk = db.prepare(
      'INSERT INTO chunks (id, document_id, ordinal, text, token_count, char_start, char_end, privacy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertFts = db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)');
    chunks.forEach((chunk, ordinal) => {
      const chunkId = randomUUID();
      insertChunk.run(
        chunkId,
        documentId,
        ordinal,
        chunk.text,
        Math.ceil(chunk.text.length / 2),
        chunk.start,
        chunk.end,
        source.privacy,
      );
      insertFts.run(chunkId, chunk.text);
    });

    recordDedupeSuggestions(db, source.id, documentId, assetId!, sha256, simhashValue);

    db.prepare(
      "INSERT INTO ingest_jobs (id, source_id, locator, sha256, state, attempts, started_at, finished_at) VALUES (?, ?, ?, ?, 'ok', 0, ?, ?) ON CONFLICT(source_id, locator, sha256) DO UPDATE SET state = 'ok', error = NULL, finished_at = excluded.finished_at",
    ).run(randomUUID(), source.id, path, sha256, Date.now(), Date.now());

    return 'indexed';
  });
}

export async function scanSource(db: DatabaseSync, sourceId: string): Promise<ScanResult> {
  const source = getSource(db, sourceId);
  if (!source) throw new Error('SOURCE_NOT_FOUND');

  const patterns = [...DEFAULT_IGNORES, ...parseIgnore(source.ignore_json)];
  const files = walk(source.uri, patterns);
  const result: ScanResult = {
    sourceId,
    scanned: files.length,
    indexed: 0,
    skipped: 0,
    failed: 0,
  };

  for (const file of files) {
    try {
      const outcome = await indexFile(db, source, file);
      result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      db.prepare(
        "INSERT INTO ingest_jobs (id, source_id, locator, sha256, state, attempts, error, started_at, finished_at) VALUES (?, ?, ?, NULL, 'failed', 1, ?, ?, ?)",
      ).run(
        randomUUID(),
        sourceId,
        file,
        error instanceof Error ? error.message : String(error),
        Date.now(),
        Date.now(),
      );
    }
  }

  const scannedPaths = new Set(files);
  const assets = db
    .prepare('SELECT id, path FROM assets WHERE source_id = ?')
    .all(sourceId) as Array<{ id: string; path: string }>;
  for (const asset of assets) {
    if (!scannedPaths.has(asset.path)) {
      const status = isIgnored(relative(source.uri, asset.path), patterns) ? 'ignored' : 'missing';
      db.prepare('UPDATE assets SET status = ? WHERE id = ?').run(status, asset.id);
    }
  }

  return result;
}

export async function indexPath(
  db: DatabaseSync,
  sourceId: string,
  path: string,
): Promise<'indexed' | 'skipped'> {
  const source = getSource(db, sourceId);
  if (!source) throw new Error('SOURCE_NOT_FOUND');
  if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) return 'skipped';
  if (!existsSync(path)) {
    markMissing(db, sourceId, path);
    return 'skipped';
  }
  return indexFile(db, source, path);
}

export function markMissing(db: DatabaseSync, sourceId: string, path: string): boolean {
  const result = db
    .prepare("UPDATE assets SET status = 'missing' WHERE source_id = ? AND path = ?")
    .run(sourceId, path);
  return result.changes > 0;
}
