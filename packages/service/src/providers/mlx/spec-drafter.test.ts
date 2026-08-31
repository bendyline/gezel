import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { drafterDirFor, resolveSpecDrafter } from './spec-drafter.js';

let root: string;
let modelDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gezel-spec-drafter-'));
  modelDir = join(root, 'engines', 'mlx', 'models', 'qwen3.8-27b-q4');
  mkdirSync(modelDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeDrafter(dir: string, bytes: number): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'model.safetensors'), Buffer.alloc(bytes));
  writeFileSync(join(dir, 'config.json'), '{}');
  return dir;
}

describe('resolveSpecDrafter', () => {
  it('finds the conventional drafter beside the model tree', () => {
    const dir = makeDrafter(drafterDirFor(modelDir), 1024);
    const plan = resolveSpecDrafter({ modelDir });
    expect(plan?.dir).toBe(dir);
    expect(plan?.source).toBe('convention');
    // Size feeds the resident-weights term, so it must count real bytes.
    expect(plan?.bytes).toBe(1024 + 2);
  });

  it('serves normally when the model has no drafter', () => {
    expect(resolveSpecDrafter({ modelDir })).toBeNull();
  });

  it('keys on the model directory, not a stripped base name', () => {
    // A drafter built for a different quantization must NOT be picked up
    // implicitly — pairing a drafter with the wrong checkpoint is a silent
    // correctness hazard, so sharing is an explicit act (symlink/config).
    makeDrafter(join(root, 'engines', 'mlx', 'drafters', 'qwen3.8-27b-mtp'), 512);
    expect(resolveSpecDrafter({ modelDir })).toBeNull();
  });

  it('prefers an explicitly configured drafter', () => {
    makeDrafter(drafterDirFor(modelDir), 1024);
    const custom = makeDrafter(join(root, 'shared-drafter'), 4096);
    const plan = resolveSpecDrafter({ modelDir, configuredPath: custom });
    expect(plan?.dir).toBe(custom);
    expect(plan?.source).toBe('configured');
  });

  it('honors the master off switch even with a drafter present', () => {
    makeDrafter(drafterDirFor(modelDir), 1024);
    expect(resolveSpecDrafter({ modelDir, enabled: false })).toBeNull();
  });

  it('treats an unreadable or non-directory drafter as absent', () => {
    const path = join(root, 'not-a-dir');
    writeFileSync(path, 'x');
    expect(resolveSpecDrafter({ modelDir, configuredPath: path })).toBeNull();
    expect(resolveSpecDrafter({ modelDir, configuredPath: join(root, 'missing') })).toBeNull();
  });

  it('needs a model dir to apply the convention', () => {
    expect(resolveSpecDrafter({})).toBeNull();
  });
});
