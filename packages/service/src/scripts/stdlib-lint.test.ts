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
 *  1. Every stdlib script parses, matches its filename, declares its kind
 *     explicitly (gates as `gate`, everything else as `action`), and stays
 *     inside its tier's capability allowlist — gates are read-mostly, and
 *     the action tier may mutate only through the sandboxed SDK workspace
 *     surface. Those allowlists are what justify the trusted "runs under
 *     any security policy" carve-out.
 *  2. Every stdlib gate delegates to `@bendyline/gezel-sdk/checks` —
 *     the one-source-of-truth property between gates, the stdlib, and
 *     the eval harness is enforced, not aspirational.
 *  3. Every `scope: 'standard'` gate ref across the bundled craftbook
 *     gallery names a real stdlib script AND its inputs validate against
 *     that script's meta — what makes 400+ generated books safe at scale.
 */

const ALLOWED_STDLIB_GATE_CAPABILITIES = new Set([
  'workspace.read',
  'artifacts.read',
  'tasks.read',
  // Expensive, opt-in checks that delegate to an already-sandboxed local
  // MCP executor (page rendering or a caller-pinned workspace checker).
  'network',
]);

// Action scripts are the stdlib's read-write tier (e.g. storeRecords,
// publishCorpusBatches). Writes go through the same sandboxed dispatcher as
// user scripts, and the artifacts drawer is the narrower of the two surfaces —
// derived, regenerable, and the only one a writes-off project exposes at all.
// Nothing here may reach network, llm, or credentials. `index.refresh`
// (ensureIndexFresh) mutates only derived index state by scheduling the same
// scan/enrichment the daemon runs on its own; the drive path itself still
// honors per-project indexing opt-out, the pause switch, and roster gating.
const ALLOWED_STDLIB_ACTION_CAPABILITIES = new Set([
  'workspace.read',
  'workspace.write',
  'artifacts.read',
  'artifacts.write',
  'index.refresh',
]);

describe('standard script library', () => {
  it('every script parses, matches its filename, and stays inside its tier', async () => {
    const dir = join(await resolveStdlibDir(), 'scripts');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const file of files) {
      const name = file.slice(0, -3);
      const source = await readFile(join(dir, file), 'utf8');
      const meta = parseScriptMeta(source, file);
      expect(meta.name, file).toBe(name);
      if (meta.kind === 'gate') {
        for (const cap of meta.requires ?? []) {
          expect(ALLOWED_STDLIB_GATE_CAPABILITIES.has(cap), `${file} requires "${cap}"`).toBe(true);
        }
        // The GateResult contract: declared outputs include decision + message.
        expect(meta.outputs?.decision, `${file} must declare a decision output`).toBeDefined();
        expect(meta.outputs?.message, `${file} must declare a message output`).toBeDefined();
        // One source of truth: the check logic comes from the shared module.
        expect(
          source.includes("from '@bendyline/gezel-sdk/checks'"),
          `${file} must import from @bendyline/gezel-sdk/checks`,
        ).toBe(true);
      } else {
        expect(meta.kind, `${file} must declare kind: 'gate' or kind: 'action'`).toBe('action');
        for (const cap of meta.requires ?? []) {
          expect(ALLOWED_STDLIB_ACTION_CAPABILITIES.has(cap), `${file} requires "${cap}"`).toBe(
            true,
          );
        }
      }
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
            // Step-triggered runs inject taskRef/stepId when the script
            // declares them, so validate the same effective input shape
            // the runtime sees rather than requiring every gallery book to
            // hard-code invocation-specific task context.
            const inputs = {
              ...(meta.inputs?.taskRef ? { taskRef: 'gallery-lint/1' } : {}),
              ...(meta.inputs?.stepId ? { stepId: step.id } : {}),
              ...(ref.inputs ?? {}),
            };
            expect(
              () => validateScriptInput(meta, inputs),
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
