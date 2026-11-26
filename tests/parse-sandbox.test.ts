import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseInSandbox } from '../src/parse-sandbox.js';

afterEach(() => {
  delete process.env.CONGNI_PARSE_TEST_DELAY_MS;
});

describe('parse sandbox', () => {
  it('kills the parser when it exceeds the timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-sandbox-'));
    const file = join(root, 'slow.pdf');
    writeFileSync(file, 'not a pdf');

    process.env.CONGNI_PARSE_TEST_DELAY_MS = '2000';
    await expect(parseInSandbox(file, '.pdf', { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'PARSE_TIMEOUT',
    });
  });

  it('reports corrupt input as a parse failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-sandbox-'));
    const file = join(root, 'broken.pdf');
    writeFileSync(file, 'definitely not a pdf');

    await expect(parseInSandbox(file, '.pdf', { timeoutMs: 10000 })).rejects.toMatchObject({
      code: 'PARSE_FAILED',
    });
  });
});
