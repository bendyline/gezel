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
    expect(body).toContain('windowsHide: true');
  });

  it('launches workspace and sandboxed Node children headlessly too', () => {
    expect(source('../workspace/command.ts')).toContain('windowsHide: true');

    const sandbox = source('../sandbox/runner.ts');
    expect(sandbox.match(/windowsHide: true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
