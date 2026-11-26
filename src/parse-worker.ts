import { readFileSync } from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import { parseBuffer } from './parse.js';

const RESULT_MARKER = '__CONGNI_RESULT__';

function networkDenied(): never {
  throw new Error('NETWORK_DISABLED');
}

// 解析器不可信：在子进程里禁用出站网络，解析前即生效。
(net.Socket.prototype as { connect: unknown }).connect = () => networkDenied();
(dns as { lookup: unknown }).lookup = () => networkDenied();

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as { path: string; ext: string };

  if (process.env.CONGNI_PARSE_TEST_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.CONGNI_PARSE_TEST_DELAY_MS)));
  }

  try {
    const parsed = await parseBuffer(readFileSync(input.path), input.ext);
    process.stdout.write(
      `${RESULT_MARKER}${JSON.stringify({
        ok: true,
        text: parsed.text,
        pages: parsed.pages,
        parserVersion: parsed.parserVersion,
      })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${RESULT_MARKER}${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 2;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

await main();
