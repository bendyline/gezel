import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptTemplateIdSchema } from '@bendyline/gezel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { craftbookScriptHeader } from './install.js';
import { parseScriptMeta } from './meta.js';
import {
  computeScriptDiagnostics,
  readScriptSource,
  scaffoldScript,
  scriptSourceHash,
  writeScriptSource,
} from './source.js';

const VALID = `import { defineScript, gezel } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'sample',
  description: 'A perfectly fine sample script.',
  outputs: { ok: { type: 'boolean', description: 'Done flag.' } },
  requires: [],
});

gezel.output({ ok: true });
`;

describe('computeScriptDiagnostics', () => {
  it('returns no diagnostics for a valid script', () => {
    expect(computeScriptDiagnostics(VALID, 'sample.ts', 'sample')).toEqual([]);
  });

  it('every scaffold template produces a clean, meta-valid script', () => {
    for (const template of ScriptTemplateIdSchema.options) {
      const source = scaffoldScript('my-script', 'A description well over ten chars.', template);
      expect(parseScriptMeta(source, `${template}.ts`).name).toBe('my-script');
      expect(
        computeScriptDiagnostics(source, `${template}.ts`, 'my-script'),
        `template ${template}`,
      ).toEqual([]);
    }
  });

  it('flags a missing meta block as a meta error', () => {
    const diags = computeScriptDiagnostics('const x = 1;\n', 'x.ts', 'x');
    expect(diags.some((d) => d.source === 'meta' && d.severity === 'error')).toBe(true);
  });

  it('warns when meta.name does not match the file name', () => {
    const diags = computeScriptDiagnostics(VALID, 'other.ts', 'other');
    expect(diags).toEqual([expect.objectContaining({ severity: 'warning', source: 'meta' })]);
  });

  it('flags TypeScript syntax errors with a line anchor', () => {
    const diags = computeScriptDiagnostics(`${VALID}\nconst broken = {;\n`, 's.ts');
    const syntax = diags.find((d) => d.source === 'typescript');
    expect(syntax).toBeDefined();
    expect(syntax?.severity).toBe('error');
    expect(syntax?.line).toBeGreaterThan(1);
  });

  it('flags enums as runtime-compat errors (strip-types rejects them)', () => {
    const diags = computeScriptDiagnostics(`${VALID}\nenum Mode { A, B }\n`, 's.ts');
    const compat = diags.find((d) => d.source === 'runtime-compat');
    expect(compat?.severity).toBe('error');
    expect(compat?.message).toContain('enums');
  });

  it('flags namespaces with runtime code but allows type-only namespaces', () => {
    const runtime = computeScriptDiagnostics(
      `${VALID}\nnamespace N { export const x = 1; }\n`,
      's.ts',
    );
    expect(runtime.some((d) => d.source === 'runtime-compat')).toBe(true);

    const typeOnly = computeScriptDiagnostics(
      `${VALID}\nnamespace N { export type T = string; }\n`,
      's.ts',
    );
    expect(typeOnly.filter((d) => d.source === 'runtime-compat')).toEqual([]);
  });

  it('flags constructor parameter properties and import-equals', () => {
    const paramProp = computeScriptDiagnostics(
      `${VALID}\nclass C { constructor(private x: number) {} }\n`,
      's.ts',
    );
    expect(paramProp.some((d) => d.source === 'runtime-compat')).toBe(true);

    const importEquals = computeScriptDiagnostics(
      `import fs = require('node:fs');\n${VALID}`,
      's.ts',
    );
    expect(importEquals.some((d) => d.source === 'runtime-compat')).toBe(true);
  });
});

describe('readScriptSource / writeScriptSource', () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-source-'));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it('round-trips source with hash and parsed meta', async () => {
    const { hash } = await writeScriptSource(home, 'p1', 'sample', VALID);
    expect(hash).toBe(scriptSourceHash(VALID));
    const read = await readScriptSource(home, 'p1', 'sample');
    expect(read?.source).toBe(VALID);
    expect(read?.hash).toBe(hash);
    expect(read?.meta?.name).toBe('sample');
    expect(read?.metaError).toBeUndefined();
    expect(read?.provenance).toBeUndefined();
  });

  it('returns the raw file with metaError when meta is broken', async () => {
    await writeScriptSource(home, 'p1', 'broken', 'const nope = true;\n');
    const read = await readScriptSource(home, 'p1', 'broken');
    expect(read?.source).toContain('nope');
    expect(read?.meta).toBeUndefined();
    expect(read?.metaError).toContain('meta');
  });

  it('surfaces craftbook provenance from the marker line', async () => {
    const marked = `${craftbookScriptHeader('pu/pull-request-review', '1.0.0')}${VALID}`;
    await writeScriptSource(home, 'p1', 'bundled', marked);
    const read = await readScriptSource(home, 'p1', 'bundled');
    expect(read?.provenance).toEqual({
      kind: 'craftbook',
      ref: 'pu/pull-request-review@1.0.0',
    });
  });

  it('returns null for a missing script', async () => {
    expect(await readScriptSource(home, 'p1', 'nope')).toBeNull();
  });

  it('rejects path-traversal names before touching the filesystem', async () => {
    await expect(readScriptSource(home, 'p1', '../escape')).rejects.toThrow();
    await expect(writeScriptSource(home, 'p1', 'a/b', 'x')).rejects.toThrow();
  });
});

describe('computeScriptDiagnostics — sandbox-hostile imports', () => {
  it('errors on raw fs imports (static, node:-prefixed, promises, dynamic)', () => {
    for (const spec of ['fs', 'node:fs', 'fs/promises', 'node:fs/promises']) {
      const diags = computeScriptDiagnostics(
        `import { readFileSync } from '${spec}';\n${VALID}`,
        'sample.ts',
        'sample',
      );
      const hit = diags.find((d) => d.source === 'runtime-compat' && d.message.includes(spec));
      expect(hit, spec).toBeDefined();
      expect(hit!.severity).toBe('error');
      expect(hit!.message).toContain('gezel.fs');
      expect(hit!.line).toBe(1);
    }
    const dynamic = computeScriptDiagnostics(
      `${VALID}\nconst fs = await import('node:fs');\n`,
      'sample.ts',
      'sample',
    );
    expect(dynamic.some((d) => d.message.includes("'node:fs'"))).toBe(true);
  });

  it("allows 'path' and other pure builtins", () => {
    const diags = computeScriptDiagnostics(
      `import { join } from 'node:path';\n${VALID}`,
      'sample.ts',
      'sample',
    );
    expect(diags).toEqual([]);
  });
});
