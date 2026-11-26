import type { DatabaseSync } from '../sqlite.js';
import { withTx } from '../db.js';
import type { EmbeddingRow, Embedder, VectorHit } from './contracts.js';
import { NotImplementedError } from './errors.js';

/**
 * L2 向量骨架：用 BLOB 普通表隔离 sqlite-vec 依赖（04 §5.7 的目标仍是 vec0）。
 * 这里真正实现的是 I19 模型/维度一致性强制点，而不是编码或 ANN 检索。
 */
export function checkEmbeddingModel(
  db: DatabaseSync,
  model: string,
  dim: number,
): { ok: boolean; detail: string } {
  const rows = db
    .prepare('SELECT DISTINCT model, dim FROM chunk_embeddings')
    .all() as Array<{ model: string; dim: number }>;
  const mismatched = rows.filter((row) => row.model !== model || row.dim !== dim);
  return {
    ok: mismatched.length === 0,
    detail:
      mismatched.length === 0
        ? `当前库无冲突模型（${rows.length} 组）`
        : `I19 冲突：已有 ${mismatched.map((r) => `${r.model}@${r.dim}`).join(', ')}，写入 ${model}@${dim}`,
  };
}

export function upsertEmbeddings(db: DatabaseSync, rows: EmbeddingRow[]): void {
  if (rows.length === 0) return;
  const first = rows[0];
  const consistency = checkEmbeddingModel(db, first.model, first.dim);
  if (!consistency.ok) throw new Error(consistency.detail);

  withTx(db, () => {
    const statement = db.prepare(
      `INSERT INTO chunk_embeddings
         (chunk_id, chunk_type, model, dim, vector, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id, model) DO UPDATE SET
         chunk_type = excluded.chunk_type,
         dim = excluded.dim,
         vector = excluded.vector,
         created_at = excluded.created_at`,
    );
    const now = Date.now();
    for (const row of rows) {
      if (row.vector.length !== row.dim) {
        throw new Error(`I19: 向量维度不符，声明 ${row.dim} 实际 ${row.vector.length}（${row.chunk_id}）`);
      }
      if (row.model !== first.model || row.dim !== first.dim) {
        throw new Error('I19: 同一批次不得混用 embedding 模型或维度');
      }
      statement.run(
        row.chunk_id,
        row.chunk_type,
        row.model,
        row.dim,
        Buffer.from(new Float32Array(row.vector).buffer),
        now,
      );
    }
  });
}

export function readEmbedding(db: DatabaseSync, chunkId: string, model: string): number[] | null {
  const row = db
    .prepare('SELECT vector, dim FROM chunk_embeddings WHERE chunk_id = ? AND model = ?')
    .get(chunkId, model) as { vector: Uint8Array; dim: number } | undefined;
  if (!row) return null;
  return Array.from(new Float32Array(row.vector.slice(0, row.dim * 4).buffer));
}

export const stubEmbedder: Embedder = {
  model: () => 'bge-small-zh-v1.5',
  dimension: () => 512,
  embed: () => Promise.reject(new NotImplementedError('embedder.embed（本地模型未接入）')),
};

/** 目标实现见 04 §5.7 vec0；引入 sqlite-vec 需另写 ADR（换模型要重建全部向量） */
export function searchVectors(
  _db: DatabaseSync,
  _queryVector: number[],
  _limit: number,
): VectorHit[] {
  throw new NotImplementedError('向量 ANN 检索（待引入 sqlite-vec）');
}
