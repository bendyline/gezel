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
    expect(body).toContain('windowsHeadlessSpawnOptions()');
  });

  it('keeps workspace and sandboxed Node children hidden on Windows', () => {
    const workspace = source('../workspace/command.ts');
    expect(workspace).toContain("detached: process.platform !== 'win32'");
    expect(workspace).toContain('windowsHeadlessSpawnOptions()');

    const sandbox = source('../sandbox/runner.ts');
    expect(sandbox).toContain("detached: process.platform !== 'win32'");
    expect(sandbox.match(/windowsHeadlessSpawnOptions\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('keeps concurrent security probes and provider CLI children hidden on Windows', () => {
    const securityTools = source('../security/external-tools.ts');
    expect(
      securityTools.match(/windowsHeadlessSpawnOptions\(\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);

    for (const providerPath of [
      '../providers/anthropic-cli/binary.ts',
      '../providers/anthropic-cli/worker.ts',
      '../providers/codex-cli/binary.ts',
      '../providers/codex-cli/invoker.ts',
      '../providers/codex-cli/quota.ts',
    ]) {
      expect(source(providerPath), providerPath).toContain('windowsHeadlessSpawnOptions()');
    }

    const signature = source('../engines/signature.ts');
    expect(signature).toContain("'-WindowStyle'");
    expect(signature).toContain("'Hidden'");
  });

  // Node documents Windows detachment as giving the child its own console.
  // Owned service children must use the headless helper instead; detachment
  // is reserved for the few processes intentionally allowed to outlive us.
  it('does not use Windows detachment as the service headless policy', () => {
    for (const caller of productionTypeScriptFiles()) {
      const name = relative(serviceSrc, caller).replaceAll('\\', '/');
      const body = readFileSync(caller, 'utf8');
      if (name === 'providers/ollama-launch.ts') {
        // Ollama intentionally outlives the daemon; only its launcher may
        // combine real detachment with a hidden intermediate Windows console.
        expect(body).toContain('windowsDetachedSpawnOptions()');
        continue;
      }
      expect(body, name).not.toContain('windowsDetachedSpawnOptions');
    }
  });
});
