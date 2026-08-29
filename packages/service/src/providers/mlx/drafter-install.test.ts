import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MlxModelManager } from './models.js';

/**
 * The drafter install is what turns speculative decoding on for a catalog
 * entry: the launcher arms from a drafter's *presence* at
 * `engines/mlx/drafters/<modelId>-<kind>`, so landing the files there IS
 * enabling the feature. Two properties matter more than the download itself —
 * corrupt bytes must never be installed (a broken drafter would arm
 * speculation and then fail at engine boot), and a failed fetch must leave the
 * model perfectly usable, because speculation is a speed optimization that
 * cannot change what the model emits.
 */
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const WEIGHTS = Buffer.from('fake-mtp-weights');
const CONFIG = Buffer.from('{"model_type":"qwen3_5_mtp"}');

function drafterSpec(overrides: Record<string, unknown> = {}) {
  return {
    huggingfaceRepo: 'Bendyline/fixture-mtp-drafter',
    revision: 'a'.repeat(40),
    kind: 'mtp' as const,
    approxSizeBytes: WEIGHTS.length + CONFIG.length,
    files: [
      { name: 'config.json', sha256: sha(CONFIG), sizeBytes: CONFIG.length },
      { name: 'model.safetensors', sha256: sha(WEIGHTS), sizeBytes: WEIGHTS.length },
    ],
    ...overrides,
  };
}

function manager(home: string, files: Record<string, Buffer>, seen?: string[]) {
  const fetchImpl = (async (url: string) => {
    const name = decodeURIComponent((url.split('/').pop() ?? '').split('?')[0] ?? '');
    seen?.push(url);
    const bytes = files[name];
    if (!bytes) return new Response(null, { status: 404, statusText: 'Not Found' });
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  }) as unknown as typeof fetch;
  return new MlxModelManager({ home, catalog: {} as unknown as CatalogService, fetchImpl });
}

const drafterDir = (home: string) => join(home, 'engines', 'mlx', 'drafters', 'fixture-model-mtp');

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-drafter-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('MLX drafter install', () => {
  it('lands files where the launcher arms speculation from', async () => {
    const m = manager(home, { 'config.json': CONFIG, 'model.safetensors': WEIGHTS });
    await (m as never as { installDrafter: (id: string, d: unknown) => Promise<void> }).installDrafter(
      'fixture-model',
      drafterSpec(),
    );
    const dir = drafterDir(home);
    expect(existsSync(join(dir, 'model.safetensors'))).toBe(true);
    expect(readFileSync(join(dir, 'model.safetensors'))).toEqual(WEIGHTS);
    expect(readFileSync(join(dir, 'config.json'))).toEqual(CONFIG);
    // No `.partial` left behind — the launcher must not see a half-file.
    expect(existsSync(join(dir, 'model.safetensors.partial'))).toBe(false);
  });

  it('fetches from the pinned revision, not main', async () => {
    const seen: string[] = [];
    const m = manager(home, { 'config.json': CONFIG, 'model.safetensors': WEIGHTS }, seen);
    await (m as never as { installDrafter: (id: string, d: unknown) => Promise<void> }).installDrafter(
      'fixture-model',
      drafterSpec(),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) expect(url).toContain(`/resolve/${'a'.repeat(40)}/`);
  });

  it('installs nothing when a file fails its sha256', async () => {
    // A corrupt drafter that armed speculation would fail at engine boot;
    // absent is strictly better than wrong.
    const m = manager(home, { 'config.json': CONFIG, 'model.safetensors': Buffer.from('tampered') });
    await (m as never as { installDrafter: (id: string, d: unknown) => Promise<void> }).installDrafter(
      'fixture-model',
      drafterSpec(),
    );
    expect(existsSync(drafterDir(home))).toBe(false);
  });

  it('never throws when the drafter is unavailable', async () => {
    // The model install must survive a missing/renamed drafter repo.
    const m = manager(home, {});
    await expect(
      (m as never as { installDrafter: (id: string, d: unknown) => Promise<void> }).installDrafter(
        'fixture-model',
        drafterSpec(),
      ),
    ).resolves.toBeUndefined();
    expect(existsSync(drafterDir(home))).toBe(false);
  });
});
