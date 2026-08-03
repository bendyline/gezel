import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serviceSrc = fileURLToPath(new URL('../', import.meta.url));

function source(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

function productionTypeScriptFiles(dir = serviceSrc): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });
}

describe('machine-service child-process contract', () => {
  it('routes every direct pnpm child through the headless spawn boundary', () => {
    for (const caller of productionTypeScriptFiles()) {
      const body = readFileSync(caller, 'utf8');
      if (!body.includes('resolvePnpmCommand(')) continue;

      const name = relative(serviceSrc, caller).replaceAll('\\', '/');
      if (name === 'packages/pnpm.ts') continue;
      if (name === 'workspace/scripts.ts') {
        // This caller delegates process creation to runWorkspaceCommand,
        // whose machine-service policy is asserted below.
        expect(body).toContain('runWorkspaceCommand(');
        continue;
      }

      expect(body, name).toContain('spawnPnpm(');
      expect(body, name).not.toContain('pnpmSpawnTarget');
    }
  });

  it('keeps the low-level pnpm target private so callers cannot bypass the policy', () => {
    const body = source('./pnpm.ts');
    expect(body).toContain('function pnpmSpawnTarget(');
    expect(body).not.toContain('export function pnpmSpawnTarget(');
    expect(body).toContain('windowsDetachedSpawnOptions()');
  });

  it('launches workspace and sandboxed Node children with no console at all', () => {
    expect(source('../workspace/command.ts')).toContain('detached: true');

    const sandbox = source('../sandbox/runner.ts');
    const detached =
      (sandbox.match(/windowsDetachedSpawnOptions\(\)/g)?.length ?? 0) +
      (sandbox.match(/detached: true/g)?.length ?? 0);
    expect(detached).toBeGreaterThanOrEqual(2);
  });

  // CREATE_NO_WINDOW reads like the headless flag and is not one: it still
  // allocates a console, and the machine service's Session 0 can allocate
  // none. DETACHED_PROCESS (`detached`) is the flag that asks for nothing.
  //
  // Note what this rule is not. It was adopted believing it fixed the
  // `spawn EPERM` that killed every native launch under the machine service;
  // v1.26215.31 shipped it and the failure continued, because the real cause
  // was a write-restricted service token. Keep the rule — asking Session 0
  // for a console it cannot give is still wrong — but do not read a passing
  // test here as evidence that spawning works.
  it('never asks for CREATE_NO_WINDOW in production service code', () => {
    for (const caller of productionTypeScriptFiles()) {
      const name = relative(serviceSrc, caller).replaceAll('\\', '/');
      expect(readFileSync(caller, 'utf8'), name).not.toContain('windowsHide: true');
    }
  });
});
