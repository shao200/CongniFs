import { watch, type FSWatcher } from 'chokidar';
import { extname, relative } from 'node:path';
import type { DatabaseSync } from './sqlite.js';
import { indexPath, markMissing } from './ingest.js';
import { DEFAULT_IGNORES, isIgnored, parseIgnore } from './ignore.js';
import { SUPPORTED_EXTENSIONS } from './parse.js';

export interface WatcherOptions {
  debounceMs?: number;
  stabilityMs?: number;
}

export interface WatcherHandle {
  readonly ready: Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
}

type ChangeKind = 'add' | 'change' | 'unlink';

interface SourceRow {
  id: string;
  uri: string;
  ignore_json: string | null;
}

export function startWatchers(
  db: DatabaseSync,
  options: WatcherOptions = {},
): WatcherHandle {
  let watchers: FSWatcher[] = [];
  const timers = new Map<string, NodeJS.Timeout>();
  let ready = Promise.resolve();
  let closed = false;

  const clearTimers = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  const closeWatchers = async () => {
    const current = watchers;
    watchers = [];
    await Promise.all(current.map((watcher) => watcher.close()));
  };

  const schedule = (sourceId: string, path: string, kind: ChangeKind) => {
    if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) return;
    const key = `${sourceId}|${path}`;
    const pending = timers.get(key);
    if (pending) clearTimeout(pending);

    const timer = setTimeout(() => {
      timers.delete(key);
      const task =
        kind === 'unlink'
          ? Promise.resolve(markMissing(db, sourceId, path))
          : indexPath(db, sourceId, path);
      task.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[watch] ${path}: ${message}`);
      });
    }, options.debounceMs ?? 2000);

    timer.unref();
    timers.set(key, timer);
  };

  const boot = (): Promise<void> => {
    const sources = db
      .prepare('SELECT id, uri, ignore_json FROM sources WHERE enabled = 1')
      .all() as unknown as SourceRow[];

    ready = Promise.all(
      sources.map(
        (source) =>
          new Promise<void>((resolve, reject) => {
            const patterns = [...DEFAULT_IGNORES, ...parseIgnore(source.ignore_json)];
            const watcher = watch(source.uri, {
              ignoreInitial: true,
              ignored: (path: string) => isIgnored(relative(source.uri, path), patterns),
              awaitWriteFinish: {
                stabilityThreshold: options.stabilityMs ?? 2000,
                pollInterval: 100,
              },
            });

            let settled = false;
            watcher.on('ready', () => {
              settled = true;
              resolve();
            });
            watcher.on('error', (error) => {
              if (!settled) {
                settled = true;
                reject(error);
              } else {
                console.error('[watch] error:', error);
              }
            });
            watcher.on('add', (path) => schedule(source.id, path, 'add'));
            watcher.on('change', (path) => schedule(source.id, path, 'change'));
            watcher.on('unlink', (path) => schedule(source.id, path, 'unlink'));

            watchers.push(watcher);
          }),
      ),
    ).then(() => undefined);

    return ready;
  };

  boot();

  return {
    get ready() {
      return ready;
    },
    reload: async () => {
      clearTimers();
      await closeWatchers();
      if (!closed) await boot();
    },
    close: async () => {
      closed = true;
      clearTimers();
      await closeWatchers();
    },
  };
}
