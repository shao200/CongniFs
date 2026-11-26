import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = DatabaseSyncType;
