import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ParsedDocument } from './parse.js';
import { parseBuffer } from './parse.js';

const WORKER_PATH = fileURLToPath(new URL('./parse-worker.ts', import.meta.url));
const RESULT_MARKER = '__CONGNI_RESULT__';
const DEFAULT_TIMEOUT_MS = Number(process.env.CONGNI_PARSE_TIMEOUT_MS ?? 30_000);
const DEFAULT_MAX_OUTPUT = Number(process.env.CONGNI_PARSE_MAX_OUTPUT ?? 20 * 1024 * 1024);

export class ParseSandboxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ParseSandboxError';
  }
}

export interface SandboxOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export function parseInSandbox(
  path: string,
  ext: string,
  options: SandboxOptions = {},
): Promise<ParsedDocument> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=512', '--import', 'tsx', WORKER_PATH],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          SYSTEMROOT: process.env.SYSTEMROOT,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          CONGNI_PARSE_TEST_DELAY_MS: process.env.CONGNI_PARSE_TEST_DELAY_MS,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const finish = (error?: Error, value?: ParsedDocument) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolve(value!);
      }
    };

    const timer = setTimeout(() => {
      finish(new ParseSandboxError('PARSE_TIMEOUT', `解析超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutput) {
        finish(new ParseSandboxError('PARSE_TOO_LARGE', '解析输出超过上限'));
        return;
      }
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
    });

    child.on('error', (error) => {
      finish(new ParseSandboxError('PARSE_FAILED', error.message));
    });

    child.on('close', (code) => {
      if (settled) return;
      const line = stdout
        .split(/\r?\n/)
        .filter((item) => item.startsWith(RESULT_MARKER))
        .pop();

      if (!line) {
        finish(
          new ParseSandboxError(
            'PARSE_FAILED',
            `解析进程退出码 ${code ?? 'null'}：${stderr || '无输出'}`,
          ),
        );
        return;
      }

      try {
        const result = JSON.parse(line.slice(RESULT_MARKER.length)) as {
          ok: boolean;
          text?: string;
          pages?: number;
          parserVersion?: string;
          error?: string;
        };
        if (!result.ok) {
          finish(new ParseSandboxError('PARSE_FAILED', result.error ?? '解析失败'));
          return;
        }
        finish(undefined, {
          text: result.text ?? '',
          pages: result.pages,
          parserVersion: result.parserVersion ?? 'unknown',
        });
      } catch {
        finish(new ParseSandboxError('PARSE_FAILED', '解析进程返回了无效结果'));
      }
    });

    child.stdin.end(JSON.stringify({ path, ext }));
  });
}

const SANDBOXED_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.pptx']);

export async function parseFileSafely(
  path: string,
  ext: string,
  buffer: Buffer,
): Promise<ParsedDocument> {
  if (SANDBOXED_EXTENSIONS.has(ext)) {
    return parseInSandbox(path, ext);
  }
  return parseBuffer(buffer, ext);
}
