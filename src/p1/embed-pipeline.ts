import type { DatabaseSync } from '../sqlite.js';
import type { ChunkTypeValue, EmbeddingRow, Embedder, VectorHit } from './contracts.js';
import { stubVectorIndex } from './ports.js';
import type { VectorIndex } from './ports.js';
import { stubEmbedder, upsertEmbeddings } from './vector.js';

export interface EmbedInput {
  chunk_id: string;
  chunk_type: ChunkTypeValue;
  text: string;
}

/** 编码与落库编排：向量生成由注入 embedder 决定，I19 校验由 upsertEmbeddings 真实执行 */
export async function embedAndStore(
  db: DatabaseSync,
  items: EmbedInput[],
  embedder: Embedder = stubEmbedder,
): Promise<number> {
  if (items.length === 0) return 0;
  const vectors = await embedder.embed(items.map((item) => item.text));
  const model = embedder.model();
  const dim = embedder.dimension();
  const rows: EmbeddingRow[] = items.map((item, index) => ({
    chunk_id: item.chunk_id,
    chunk_type: item.chunk_type,
    model,
    dim,
    vector: vectors[index] ?? [],
  }));
  upsertEmbeddings(db, rows);
  return rows.length;
}

/** ANN 检索编排：索引实现由注入端口决定，默认未实现 */
export async function vectorSearch(
  queryVector: number[],
  limit: number,
  index: VectorIndex = stubVectorIndex,
): Promise<VectorHit[]> {
  return index.search(queryVector, limit);
}
