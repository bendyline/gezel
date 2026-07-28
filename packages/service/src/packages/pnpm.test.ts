import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeBundledPnpmPath, resolvePnpmCommand } from './pnpm.js';

const originalPnpmPath = process.env.GEZEL_PNPM_PATH;
const originalNodePath = process.env.GEZEL_NODE_PATH;
let workRoot: string;

beforeEach(async () => {
  delete process.env.GEZEL_PNPM_PATH;
  delete process.env.GEZEL_NODE_PATH;
  workRoot = await mkdtemp(join(tmpdir(), 'gezel-pnpm-command-'));
});

afterEach(async () => {
  if (originalPnpmPath === undefined) delete process.env.GEZEL_PNPM_PATH;
  else process.env.GEZEL_PNPM_PATH = originalPnpmPath;
  if (originalNodePath === undefined) delete process.env.GEZEL_NODE_PATH;
  else process.env.GEZEL_NODE_PATH = originalNodePath;
  await rm(workRoot, { recursive: true, force: true });
});

describe('resolvePnpmCommand', () => {
  it('launches the bundled pnpm script through bundled Node', () => {
    process.env.GEZEL_PNPM_PATH = join(workRoot, 'pnpm-runtime', 'bin', 'pnpm.mjs');
    process.env.GEZEL_NODE_PATH = join(workRoot, 'node');

    expect(resolvePnpmCommand(['--version'])).toEqual({
      command: process.env.GEZEL_NODE_PATH,
      args: [process.env.GEZEL_PNPM_PATH, '--version'],
      shell: false,
      mode: 'node-script',
    });
  });
});

describe('normalizeBundledPnpmPath', () => {
  it('redirects a missing legacy executable path to the adjacent JS entrypoint', async () => {
    const bundleDir = join(workRoot, 'pnpm-bundle');
    const entryPath = join(bundleDir, 'bin', 'pnpm.mjs');
    await mkdir(join(bundleDir, 'bin'), { recursive: true });
    await writeFile(entryPath, '// pnpm\n', 'utf8');
    process.env.GEZEL_PNPM_PATH = join(bundleDir, 'pnpm');

    expect(normalizeBundledPnpmPath()).toBe(entryPath);
    expect(process.env.GEZEL_PNPM_PATH).toBe(entryPath);
  });

  it('prefers the JS entrypoint even if an old standalone executable was left behind', async () => {
    const bundleDir = join(workRoot, 'pnpm-bundle');
    const legacyPath = join(bundleDir, 'pnpm');
    const entryPath = join(bundleDir, 'bin', 'pnpm.mjs');
    await mkdir(join(bundleDir, 'bin'), { recursive: true });
    await writeFile(legacyPath, 'old standalone\n', 'utf8');
    await writeFile(entryPath, '// pnpm\n', 'utf8');
    process.env.GEZEL_PNPM_PATH = legacyPath;

    expect(normalizeBundledPnpmPath()).toBe(entryPath);
    expect(process.env.GEZEL_PNPM_PATH).toBe(entryPath);
  });

  it('leaves an unrelated missing override unchanged', () => {
    const configured = join(workRoot, 'custom-pnpm');
    process.env.GEZEL_PNPM_PATH = configured;
    expect(normalizeBundledPnpmPath()).toBe(configured);
  });
});
