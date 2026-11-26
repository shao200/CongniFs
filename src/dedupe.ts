import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from './sqlite.js';

const MASK_64 = (1n << 64n) - 1n;

function fnv1a64(input: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & MASK_64;
  }
  return hash;
}

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = [];
  const latin = normalized.match(/[a-z0-9_]+/g) ?? [];
  tokens.push(...latin);

  const han = normalized.match(/\p{Script=Han}+/gu) ?? [];
  for (const run of han) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }
  return tokens;
}

export function simhash64(text: string): bigint {
  const weights = new Array<number>(64).fill(0);
  for (const token of tokenize(text)) {
    const hash = fnv1a64(token);
    for (let bit = 0; bit < 64; bit += 1) {
      const isSet = ((hash >> BigInt(bit)) & 1n) === 1n;
      weights[bit] += isSet ? 1 : -1;
    }
  }
  let result = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (weights[bit] > 0) result |= 1n << BigInt(bit);
  }
  return result;
}

export function hammingDistance(left: bigint, right: bigint): number {
  let value = left ^ right;
  let count = 0;
  while (value > 0n) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

interface ExistingDocument {
  id: string;
  simhash: string;
  path: string;
}

export function recordDedupeSuggestions(
  db: DatabaseSync,
  sourceId: string,
  documentId: string,
  assetId: string,
  sha256: string,
  simhash: bigint,
): void {
  const insert = db.prepare(
    `INSERT INTO organize_suggestions
       (id, kind, target_type, target_id, payload_json, reason, confidence, status, created_at)
     VALUES (?, 'dedupe', 'document', ?, ?, ?, ?, 'pending', ?)`,
  );

  const exact = db
    .prepare('SELECT id, path FROM assets WHERE sha256 = ? AND id <> ? LIMIT 1')
    .get(sha256, assetId) as { id: string; path: string } | undefined;
  if (exact) {
    insert.run(
      randomUUID(),
      documentId,
      JSON.stringify({ method: 'sha256', keep_asset_id: exact.id, keep_path: exact.path }),
      `内容哈希与《${exact.path}》完全相同`,
      1,
      Date.now(),
    );
    return;
  }

  const candidates = db
    .prepare(
      `SELECT d.id, d.simhash, a.path
         FROM documents d
         JOIN assets a ON a.id = d.asset_id
        WHERE a.source_id = ? AND d.id <> ? AND d.simhash IS NOT NULL`,
    )
    .all(sourceId, documentId) as unknown as ExistingDocument[];

  let best: { candidate: ExistingDocument; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = hammingDistance(simhash, BigInt(candidate.simhash));
    if (!best || distance < best.distance) best = { candidate, distance };
  }

  if (best && best.distance <= 4) {
    const similarity = Number((1 - best.distance / 64).toFixed(3));
    insert.run(
      randomUUID(),
      documentId,
      JSON.stringify({
        method: 'simhash',
        keep_document_id: best.candidate.id,
        keep_path: best.candidate.path,
        distance: best.distance,
      }),
      `文本相似度 ${similarity}，疑似重复《${best.candidate.path}》`,
      similarity,
      Date.now(),
    );
  }
}
