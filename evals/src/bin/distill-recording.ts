#!/usr/bin/env -S npx tsx
/**
 * `pnpm --filter @bendyline/gezel-evals exec tsx src/bin/distill-recording.ts <dir>`
 *
 * Backfill/re-run the run-recording distiller over finished trial dirs.
 * Walks a single trial dir, a scenario dir, or a whole `batch-*` /
 * `matrix-*` tree (a trial dir is one containing result.json or
 * sessions/), and writes `recording/transcript.json` into each.
 *
 * New trials get this automatically at finalize; this bin exists for
 * OLD run dirs — they distill at degraded fidelity (no per-tool-call
 * timestamps, no delegation session ids, no task notes), which is still
 * a playable timeline.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { distillRunDir } from '../recording/distill-io.ts';

function isTrialDir(dir: string): boolean {
  return existsSync(join(dir, 'result.json')) || existsSync(join(dir, 'sessions'));
}

function collectTrialDirs(root: string, depth = 0): string[] {
  if (isTrialDir(root)) return [root];
  if (depth >= 4) return [];
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = join(root, entry);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(...collectTrialDirs(child, depth + 1));
  }
  return out;
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: distill-recording <trial-dir | scenario-dir | batch/matrix-dir>');
    process.exit(2);
  }
  const root = resolve(target);
  if (!existsSync(root)) {
    console.error(`not found: ${root}`);
    process.exit(2);
  }
  const trials = collectTrialDirs(root);
  if (trials.length === 0) {
    console.error(`no trial dirs (result.json or sessions/) under ${root}`);
    process.exit(1);
  }
  let ok = 0;
  let skipped = 0;
  for (const dir of trials) {
    try {
      const stats = await distillRunDir(dir, { log: (line) => console.log(`${dir}: ${line}`) });
      if (stats) ok += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.error(`${dir}: distill failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(
    `distilled ${ok}/${trials.length} trial dir(s)${skipped ? ` (${skipped} skipped)` : ''}`,
  );
}

void main();
