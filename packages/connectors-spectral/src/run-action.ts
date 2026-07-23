/**
 * Sandbox entry point — the ONLY thing the service spawns for the `spectral`
 * driver. Runs with network ON but workspace OFF, env scrubbed, and the
 * connection (with its secret) arriving over stdin — never env. Reads one JSON
 * job, runs the vendored component action, writes `{ data }` (or `{ error }`)
 * to stdout. The untrusted component gets network but cannot see the corpus.
 *
 * Job: { component, action, connectionInput, connection, inputs }
 */

import { makeContextShim } from './context-shim.js';
import { VENDORED } from './vendor/index.js';

interface Job {
  component: string;
  action: string;
  connectionInput?: string;
  connection?: unknown;
  inputs?: Record<string, unknown>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const job = JSON.parse(await readStdin()) as Job;
  const entry = VENDORED[`${job.component}/${job.action}`];
  if (!entry) throw new Error(`no vendored spectral action: ${job.component}/${job.action}`);
  const params = {
    [job.connectionInput ?? 'connection']: job.connection,
    ...(job.inputs ?? {}),
  };
  const result = (await entry.perform(makeContextShim(), params)) as { data?: unknown };
  process.stdout.write(`${JSON.stringify({ data: result?.data ?? result })}\n`);
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
