import type { DatabaseSync } from './sqlite.js';

export interface DocumentSummary {
  id: string;
  title: string;
  path: string;
  parse_status: string;
  privacy: string;
  duplicate_of: string | null;
  created_at: number;
  chunk_count: number;
}

export function listDocuments(
  db: DatabaseSync,
  limit: number,
  offset: number,
  includeDuplicates = false,
): DocumentSummary[] {
  return db
    .prepare(
      `SELECT d.id, d.title, d.parse_status, d.privacy, d.duplicate_of, d.created_at,
              a.path, COUNT(c.id) AS chunk_count
         FROM documents d
         JOIN assets a ON a.id = d.asset_id
         LEFT JOIN chunks c ON c.document_id = d.id
        WHERE (? = 1 OR d.duplicate_of IS NULL)
          AND a.status = 'ok'
        GROUP BY d.id
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(includeDuplicates ? 1 : 0, limit, offset) as unknown as DocumentSummary[];
}

export function getDocument(db: DatabaseSync, id: string) {
  const document = db
    .prepare(
      `SELECT d.id, d.title, d.parse_status, d.privacy, d.created_at, a.path
         FROM documents d
         JOIN assets a ON a.id = d.asset_id
        WHERE d.id = ?`,
    )
    .get(id) as DocumentSummary | undefined;
  if (!document) return undefined;

  const chunks = db
    .prepare(
      `SELECT id, ordinal, text, token_count, char_start, char_end
         FROM chunks WHERE document_id = ? ORDER BY ordinal`,
    )
    .all(id) as unknown as Array<{
    id: string;
    ordinal: number;
    text: string;
    token_count: number;
    char_start: number;
    char_end: number;
  }>;

  return { ...document, chunks };
}

function ftsQuery(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '')}"`)
    .join(' ');
}

export function searchChunks(
  db: DatabaseSync,
  query: string,
  limit: number,
  includeDuplicates = false,
) {
  const match = ftsQuery(query);
  if (!match) return [];
  return db
    .prepare(
      `SELECT c.id, c.document_id, c.text, c.ordinal,
              d.title, a.path
         FROM chunks_fts f
         JOIN chunks c ON c.id = f.chunk_id
         JOIN documents d ON d.id = c.document_id
         JOIN assets a ON a.id = d.asset_id
        WHERE chunks_fts MATCH ?
          AND (? = 1 OR d.duplicate_of IS NULL)
          AND a.status = 'ok'
        LIMIT ?`,
    )
    .all(match, includeDuplicates ? 1 : 0, limit) as unknown as Array<{
    id: string;
    document_id: string;
    text: string;
    ordinal: number;
    title: string;
    path: string;
  }>;
}

export function listSuggestions(db: DatabaseSync, status: string, limit: number) {
  return db
    .prepare(
      `SELECT id, kind, target_type, target_id, payload_json, reason,
              confidence, status, created_at, decided_at
         FROM organize_suggestions
        WHERE (? = 'all' OR status = ?)
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(status, status, limit);
}
