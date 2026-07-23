import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspace } from './template.js';

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `gezel-bootstrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('bootstrapWorkspace', () => {
  it('writes package.json + tsconfig.json + .gitignore when missing', async () => {
    const written = await bootstrapWorkspace({
      workspaceDir: dir,
      projectId: 'pet-store',
      projectName: 'Pet Store',
    });
    expect(written.sort()).toEqual(['.gitignore', 'package.json', 'tsconfig.json']);

    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('pet-store');
    expect(pkg.type).toBe('module');
    expect(pkg.engines.node).toMatch(/>=24/);

    const ts = JSON.parse(await readFile(join(dir, 'tsconfig.json'), 'utf8'));
    expect(ts.compilerOptions.module).toBe('NodeNext');
    expect(ts.compilerOptions.strict).toBe(true);

    const gi = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(gi).toMatch(/node_modules/);
  });

  it('is idempotent — does not overwrite existing files on second call', async () => {
    await bootstrapWorkspace({ workspaceDir: dir, projectId: 'x' });
    // Mutate package.json
    const pkgPath = join(dir, 'package.json');
    await (await import('node:fs/promises')).writeFile(pkgPath, '{"name":"changed"}');

    const writtenSecond = await bootstrapWorkspace({ workspaceDir: dir, projectId: 'x' });
    expect(writtenSecond).toEqual([]);

    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    expect(pkg.name).toBe('changed');
  });

  it('slugifies project names for npm-compatible package names', async () => {
    await bootstrapWorkspace({
      workspaceDir: dir,
      projectId: 'id',
      projectName: 'My Cool App! 2.0',
    });
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('my-cool-app-2-0');
  });
});
