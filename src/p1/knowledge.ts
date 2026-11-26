import type { DatabaseSync } from '../sqlite.js';
import { withTx } from '../db.js';
import type { EntityInput, FactInput } from './contracts.js';

/**
 * L3 实体/事实骨架：字段口径严格对齐 04 §5.7 / §5.10，不新增同义表。
 * 抽取逻辑属 P1 实现，这里只提供可测的最小写入与读取面。
 */
export function upsertEntity(db: DatabaseSync, input: EntityInput): void {
  withTx(db, () => {
    db.prepare(
      `INSERT INTO entities (id, name, etype, canonical, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name, etype) DO UPDATE SET canonical = COALESCE(excluded.canonical, entities.canonical)`,
    ).run(input.id, input.name, input.etype, input.canonical ?? null, Date.now());
  });
}

export function linkEntity(
  db: DatabaseSync,
  entityId: string,
  targetType: 'event' | 'asset' | 'memory',
  targetId: string,
  confidence = 1.0,
): void {
  withTx(db, () => {
    db.prepare(
      `INSERT INTO entity_links (entity_id, target_type, target_id, confidence, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, target_type, target_id) DO NOTHING`,
    ).run(entityId, targetType, targetId, confidence, Date.now());
  });
}

/** 事实骨架默认 proposed：系统推断不得直接 active（04 §5.10 约束） */
export function insertFact(db: DatabaseSync, input: FactInput): void {
  withTx(db, () => {
    db.prepare(
      `INSERT INTO world_facts
         (id, subject, predicate, object, valid_from, valid_to,
          confidence, evidence_id, origin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
    ).run(
      input.id,
      input.subject,
      input.predicate,
      input.object,
      input.valid_from ?? null,
      input.valid_to ?? null,
      input.confidence ?? 0.5,
      input.evidence_id,
      input.origin ?? 'system_inferred',
      Date.now(),
    );
  });
}

export function listEntities(db: DatabaseSync, limit = 50) {
  return db
    .prepare('SELECT id, name, etype, canonical FROM entities ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<{ id: string; name: string; etype: string; canonical: string | null }>;
}

export function listFacts(db: DatabaseSync, subject?: string, limit = 50) {
  return db
    .prepare(
      `SELECT id, subject, predicate, object, status, origin, confidence
         FROM world_facts
        WHERE (? IS NULL OR subject = ?)
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(subject ?? null, subject ?? null, limit) as Array<{
    id: string;
    subject: string;
    predicate: string;
    object: string;
    status: string;
    origin: string;
    confidence: number;
  }>;
}
