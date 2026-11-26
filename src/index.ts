import { join } from 'node:path';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { startReconciler } from './reconcile.js';
import { startWatchers } from './watcher.js';

const dbPath = process.env.CONGNI_DB ?? join(process.cwd(), 'data', 'congni.db');
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const reconcileMs = Number(process.env.CONGNI_RECONCILE_MS ?? 30 * 60 * 1000);

const db = openDb(dbPath);
const watcher = startWatchers(db);
const reconciler = startReconciler(db, reconcileMs);
const app = buildApp(db, { onSourceChanged: () => watcher.reload() });

await app.listen({ host, port });
console.log(`congni server listening on http://${host}:${port}`);
console.log(`database: ${dbPath}`);

await watcher.ready;
console.log('watching enabled sources for local changes');
await reconciler.runOnce();

const shutdown = async () => {
  reconciler.stop();
  await watcher.close();
  await app.close();
  db.close();
  process.exit(0);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
