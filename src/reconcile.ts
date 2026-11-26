import type { DatabaseSync } from './sqlite.js';
import { scanSource } from './ingest.js';

export interface ReconcileSummary {
  sources: number;
  indexed: number;
  failed: number;
}

export async function reconcileAll(db: DatabaseSync): Promise<ReconcileSummary> {
  const sources = db.prepare('SELECT id FROM sources WHERE enabled = 1').all() as Array<{
    id: string;
  }>;

  let indexed = 0;
  let failed = 0;
  for (const source of sources) {
    try {
      const result = await scanSource(db, source.id);
      indexed += result.indexed;
      failed += result.failed;
    } catch (error) {
      failed += 1;
      console.error(`[reconcile] ${source.id}:`, error);
    }
  }
  return { sources: sources.length, indexed, failed };
}

export interface ReconcilerHandle {
  runOnce(): Promise<ReconcileSummary | undefined>;
  stop(): void;
}

export function startReconciler(
  db: DatabaseSync,
  intervalMs = 30 * 60 * 1000,
): ReconcilerHandle {
  let running = false;

  const runOnce = async (): Promise<ReconcileSummary | undefined> => {
    if (running) return undefined;
    running = true;
    try {
      const summary = await reconcileAll(db);
      console.log(
        `[reconcile] sources=${summary.sources} indexed=${summary.indexed} failed=${summary.failed}`,
      );
      return summary;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    runOnce().catch((error: unknown) => {
      console.error('[reconcile] failed:', error);
    });
  }, intervalMs);
  timer.unref();

  return {
    runOnce,
    stop: () => clearInterval(timer),
  };
}
