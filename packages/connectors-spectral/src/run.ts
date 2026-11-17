/**
 * Runner v2 — the entry the service spawns, in the sandbox, for connector
 * types built on a published Prismatic component.
 *
 * One `RunJob` arrives on stdin (the connection, with its secret, never in
 * env). The answer goes to files in the working folder: `out/result.json`,
 * and for `poll`/`list` the items, one per line, in `out/items.ndjson`.
 * stdout belongs to the component. The process exits 0 when it wrote a
 * result, whatever the result says; anything else is a crash.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { classify, scrub, secretsOf } from './v2/failure.js';
import { type HttpGuard, installHttpGuard } from './v2/http-guard.js';
import { loadComponent } from './v2/load-component.js';
import { type CallableComponentLike, call, describe, list, poll } from './v2/ops.js';
import type { RunJob, RunOutcome, RunResult } from './v2/protocol.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const backgroundErrors: string[] = [];

export async function runJob(job: RunJob, cwd: string): Promise<RunResult> {
  const state: { guard?: HttpGuard } = {};
  const outcome = await runOutcome(job, cwd, state);
  return job.replay ? { ...outcome, replayed: state.guard?.usedRecordings() ?? [] } : outcome;
}

async function runOutcome(
  job: RunJob,
  cwd: string,
  state: { guard?: HttpGuard },
): Promise<RunOutcome> {
  const out = join(cwd, 'out');
  mkdirSync(out, { recursive: true });
  const itemsPath = join(out, 'items.ndjson');
  const secrets = secretsOf(job.connection?.value);
  const runnerRequire = createRequire(__filename);
  let guard: HttpGuard | undefined;
  try {
    const sdkVersion = (runnerRequire('@prismatic-io/spectral/package.json') as { version: string })
      .version;
    if (job.v !== 2) throw new Error(`unsupported job version ${String(job.v)}`);
    if (job.op === 'ping') {
      // Load the SDK itself, as a sync would, so a missing read root shows here.
      runnerRequire('@prismatic-io/spectral');
      return { ok: true, op: 'ping', sdk: sdkVersion, node: process.version };
    }
    if (!job.component) throw new Error('the job names no component');
    const sdkRequire = createRequire(runnerRequire.resolve('@prismatic-io/spectral'));
    guard = state.guard = installHttpGuard({
      axios: sdkRequire('axios'),
      // `describe` runs with no origins: reading a component's shape needs no network.
      origins: job.op === 'describe' ? [] : (job.origins ?? []),
      ...(job.replay ? { replay: job.replay } : {}),
    });
    const component = loadComponent(job.component, runnerRequire) as CallableComponentLike;
    if (job.op === 'describe') return { ok: true, op: 'describe', component: describe(component) };
    const { runWithContext } = runnerRequire(
      '@prismatic-io/spectral/dist/serverTypes/asyncContext',
    ) as { runWithContext: <T>(context: unknown, fn: () => T) => T };
    const env = { runWithContext, secrets, itemsPath };
    if (job.op === 'call') return await call(component, job, env);
    if (job.op === 'poll') return await poll(component, job, env);
    if (job.op === 'list') return await list(component, job, env);
    throw new Error(`unknown operation ${String(job.op)}`);
  } catch (err) {
    const failure = classify(err, guard?.lastFailure);
    return {
      ok: false,
      op: job.op,
      error: { ...failure, message: scrub(failure.message, secrets).slice(0, 2000) },
      logs: backgroundErrors.slice(0, 20),
    };
  }
}

async function main(): Promise<void> {
  // A component's stray promise must not take the run down before it reports.
  process.on('unhandledRejection', (reason) => {
    if (backgroundErrors.length < 20) {
      backgroundErrors.push(`unhandled: ${String((reason as Error)?.message ?? reason)}`);
    }
  });
  const job = JSON.parse(await readStdin()) as RunJob;
  const secrets = secretsOf(job.connection?.value);
  const result = await runJob(job, process.cwd());
  writeFileSync(join(process.cwd(), 'out', 'result.json'), scrub(JSON.stringify(result), secrets), {
    mode: 0o600,
  });
  // Keep-alive sockets and timers a component left behind would hold the
  // process open until the host's timeout.
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
