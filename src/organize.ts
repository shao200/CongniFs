import type { DatabaseSync } from './sqlite.js';
import { withTx } from './db.js';

interface SuggestionRow {
  id: string;
  kind: string;
  target_type: string;
  target_id: string;
  payload_json: string;
  status: string;
  decided_at: number | null;
  applied_value: string | null;
}

interface DocumentRow {
  id: string;
  duplicate_of: string | null;
}

function findDocumentByAsset(db: DatabaseSync, assetId: string): string | undefined {
  const row = db.prepare('SELECT id FROM documents WHERE asset_id = ?').get(assetId) as
    | { id: string }
    | undefined;
  return row?.id;
}

function canonicalDocument(
  db: DatabaseSync,
  documentId: string,
  targetId: string,
): string | undefined {
  let current = documentId;
  for (let depth = 0; depth < 20; depth += 1) {
    const row = db.prepare('SELECT id, duplicate_of FROM documents WHERE id = ?').get(current) as
      | DocumentRow
      | undefined;
    if (!row) return undefined;
    if (!row.duplicate_of) return current;
    if (row.duplicate_of === targetId) return undefined;
    current = row.duplicate_of;
  }
  return undefined;
}

export type AcceptResult = 'accepted' | 'not_found' | 'invalid';

export function acceptSuggestion(db: DatabaseSync, id: string): AcceptResult {
  const suggestion = db
    .prepare(
      "SELECT id, kind, target_type, target_id, payload_json, status, decided_at, applied_value FROM organize_suggestions WHERE id = ?",
    )
    .get(id) as SuggestionRow | undefined;

  if (!suggestion || suggestion.status !== 'pending') return 'not_found';

  return withTx(db, () => {
    let appliedValue: string | null = null;
    if (suggestion.kind === 'dedupe') {
      const payload = JSON.parse(suggestion.payload_json) as {
        keep_document_id?: string;
        keep_asset_id?: string;
      };
      const keepDocumentId =
        payload.keep_document_id ??
        (payload.keep_asset_id ? findDocumentByAsset(db, payload.keep_asset_id) : undefined);

      if (!keepDocumentId || keepDocumentId === suggestion.target_id) return 'invalid';

      const canonical = canonicalDocument(db, keepDocumentId, suggestion.target_id);
      if (!canonical) return 'invalid';

      db.prepare('UPDATE documents SET duplicate_of = ? WHERE id = ?').run(
        canonical,
        suggestion.target_id,
      );
      appliedValue = canonical;
    }

    db.prepare(
      "UPDATE organize_suggestions SET status = 'accepted', decided_at = ?, applied_value = ? WHERE id = ?",
    ).run(Date.now(), appliedValue, id);
    return 'accepted';
  });
}

export function rejectSuggestion(db: DatabaseSync, id: string): boolean {
  const result = db
    .prepare(
      "UPDATE organize_suggestions SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'",
    )
    .run(Date.now(), id);
  return result.changes > 0;
}

export type RevokeResult = 'revoked' | 'not_found' | 'expired' | 'conflict';

const REVOKE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function revokeSuggestion(db: DatabaseSync, id: string): RevokeResult {
  const suggestion = db
    .prepare(
      "SELECT id, kind, target_type, target_id, payload_json, status, decided_at, applied_value FROM organize_suggestions WHERE id = ?",
    )
    .get(id) as SuggestionRow | undefined;

  if (!suggestion || suggestion.status !== 'accepted') return 'not_found';
  if (suggestion.decided_at && Date.now() - suggestion.decided_at > REVOKE_WINDOW_MS) {
    return 'expired';
  }

  return withTx(db, () => {
    if (suggestion.kind === 'dedupe' && suggestion.applied_value) {
      const result = db
        .prepare('UPDATE documents SET duplicate_of = NULL WHERE id = ? AND duplicate_of = ?')
        .run(suggestion.target_id, suggestion.applied_value);
      if (result.changes === 0) return 'conflict';
    }

    db.prepare(
      "UPDATE organize_suggestions SET status = 'revoked', decided_at = ?, applied_value = NULL WHERE id = ?",
    ).run(Date.now(), id);
    return 'revoked';
  });
}
