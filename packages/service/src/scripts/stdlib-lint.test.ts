import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GateScriptResultSchema,
  type StepGateUnion,
  normalizeStepGate,
  validateScriptInput,
} from '@bendyline/gezel';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import { parseScriptMeta } from './meta.js';
import { listStdlibScripts, resolveStdlibDir } from './stdlib-source.js';

/**
 * Mechanical enforcement of the standard-library contract:
 *
 *  1. Every stdlib script parses, is a gate, matches its filename, and
 *     declares only allow-listed (read-mostly) capabilities — that is
 *     what justifies the trusted "runs under any security policy"
 *     carve-out.
 *  2. Every stdlib script delegates to `@bendyline/gezel-sdk/checks` —
 *     the one-source-of-truth property between gates, the stdlib, and
 *     the eval harness is enforced, not aspirational.
 *  3. Every `scope: 'standard'` gate ref across the bundled craftbook
 *     gallery names a real stdlib script AND its inputs validate against
 *     that script's meta — what makes 400+ generated books safe at scale.
 */

const ALLOWED_STDLIB_CAPABILITIES = new Set([
  'workspace.read',
  'artifacts.read',
  'tasks.read',
  // Expensive, opt-in checks that delegate to an already-sandboxed local
  // MCP executor (page rendering or a caller-pinned workspace checker).
  'network',
]);

describe('standard script library', () => {
  it('every script parses, is a gate, matches its filename, and stays read-mostly', async () => {
    const dir = join(await resolveStdlibDir(), 'scripts');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const file of files) {
      const name = file.slice(0, -3);
      const source = await readFile(join(dir, file), 'utf8');
      const meta = parseScriptMeta(source, file);
      expect(meta.name, file).toBe(name);
      expect(meta.kind, `${file} must declare kind: 'gate'`).toBe('gate');
      for (const cap of meta.requires ?? []) {
        expect(ALLOWED_STDLIB_CAPABILITIES.has(cap), `${file} requires "${cap}"`).toBe(true);
      }
      // The GateResult contract: declared outputs include decision + message.
      expect(meta.outputs?.decision, `${file} must declare a decision output`).toBeDefined();
      expect(meta.outputs?.message, `${file} must declare a message output`).toBeDefined();
      // One source of truth: the check logic comes from the shared module.
      expect(
        source.includes("from '@bendyline/gezel-sdk/checks'"),
        `${file} must import from @bendyline/gezel-sdk/checks`,
      ).toBe(true);
    }
  });

  it('listStdlibScripts surfaces the library with parseable metas', async () => {
    const scripts = await listStdlibScripts();
    expect(scripts.length).toBeGreaterThanOrEqual(15);
    expect(scripts.map((s) => s.name)).toContain('checkFileMinBytes');
  });

  it('the GateScriptResult contract accepts the canonical stdlib outputs', () => {
    expect(
      GateScriptResultSchema.safeParse({ decision: 'approve', message: 'index.html is 4 KB' })
        .success,
    ).toBe(true);
    expect(
      GateScriptResultSchema.safeParse({
        decision: 'reject',
        message: 'index.html is 12 bytes, need ≥ 1500',
      }).success,
    ).toBe(true);
  });
});

describe('bundled craftbook gallery gate refs', () => {
  it('every standard-scope gate ref names a real stdlib script and its inputs validate', async () => {
    const templatesDir = join(gildeDataDir(), 'craftbook-templates');
    const stdlib = new Map((await listStdlibScripts()).map((s) => [s.name, s.meta]));

    let manifests = 0;
    let standardRefs = 0;
    const shards = await readdir(templatesDir);
    for (const shard of shards) {
      if (shard.startsWith('.') || shard.endsWith('.json')) continue;
      const shardDir = join(templatesDir, shard);
      let books: string[];
      try {
        books = await readdir(shardDir);
      } catch {
        continue;
      }
      for (const book of books) {
        // Craftbooks V2: the bundled layout is one craftbook.json per
        // version (steps inline); legacy manifest.json kept as fallback.
        const versionDir = join(shardDir, book, 'versions', '1.0.0');
        let manifest: { steps?: Array<{ id: string; gate?: StepGateUnion }> };
        try {
          manifest = JSON.parse(await readFile(join(versionDir, 'craftbook.json'), 'utf8'));
        } catch {
          try {
            manifest = JSON.parse(await readFile(join(versionDir, 'manifest.json'), 'utf8'));
          } catch {
            continue;
          }
        }
        manifests++;
        for (const step of manifest.steps ?? []) {
          if (!step.gate) continue;
          const gate = normalizeStepGate(step.gate);
          for (const ref of gate.scripts) {
            if (ref.scope !== 'standard') continue;
            standardRefs++;
            const meta = stdlib.get(ref.name);
            expect(meta, `${book}/${step.id}: unknown standard script "${ref.name}"`).toBeDefined();
            if (!meta) continue;
            expect(
              () => validateScriptInput(meta, ref.inputs),
              `${book}/${step.id}: inputs for "${ref.name}" do not validate`,
            ).not.toThrow();
          }
        }
      }
    }
    expect(manifests).toBeGreaterThan(100);
    // After the gallery regeneration, standard refs must be present at scale.
    expect(standardRefs).toBeGreaterThan(100);
  });
});
