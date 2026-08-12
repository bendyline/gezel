/**
 * Full-drive fan-out: `ContentIndex.enrich` keeps `concurrency()` per-file
 * scans in flight at once (the drive passes the target queue's live width),
 * and stays strictly serial when no concurrency option is given.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';
import { runWorkspaceContentIndex } from './content-indexer.js';
import type { EnrichDeps } from './enrich.js';

let dir: string;
let home: string;
let ci: ContentIndex;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-pool-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-pool-home-'));
  ci = new ContentIndex(
    {
      projectWorkspaceDir: async () => dir,
      projectArtifactsDir: () => join(home, 'artifacts'),
    } as unknown as Store,
    home,
  );
  for (let i = 0; i < 6; i++) {
    await writeFile(join(dir, `note-${i}.md`), `# Note ${i}\n\nSome prose about topic ${i}.\n`);
  }
  await runWorkspaceContentIndex(dir, 'c', join(home, 'artifacts'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function gatedDeps(): {
  deps: EnrichDeps;
  gate: Array<() => void>;
  maxInFlight: () => number;
} {
  let inFlight = 0;
  let max = 0;
  const gate: Array<() => void> = [];
  const deps: EnrichDeps = {
    summarize: async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise<void>((release) => gate.push(release));
      inFlight--;
      return 'a summary';
    },
    embed: async (texts: string[]) => texts.map(() => []),
    model: 'test-model',
  };
  return { deps, gate, maxInFlight: () => max };
}

function flushUntilDone(gate: Array<() => void>, done: Promise<unknown>): Promise<unknown> {
  const timer = setInterval(() => {
    while (gate.length > 0) gate.shift()?.();
  }, 5);
  return done.finally(() => clearInterval(timer));
}

describe('ContentIndex.enrich concurrency', () => {
  it('keeps width-many summaries in flight during a full drive', async () => {
    const { deps, gate, maxInFlight } = gatedDeps();
    const run = ci.enrich('c', deps, 10, { concurrency: () => 3 });
    // First wave: three files dispatch before any completes.
    await vi.waitFor(() => expect(gate.length).toBe(3));
    expect(maxInFlight()).toBe(3);
    const result = (await flushUntilDone(gate, run)) as { files: number; summarized: number };
    expect(result.files).toBe(6);
    expect(result.summarized).toBe(6);
    expect(maxInFlight()).toBe(3);
  });

  it('stays strictly serial without a concurrency option', async () => {
    const { deps, gate, maxInFlight } = gatedDeps();
    const result = (await flushUntilDone(gate, ci.enrich('c', deps, 10))) as { files: number };
    expect(result.files).toBe(6);
    expect(maxInFlight()).toBe(1);
  });
});
