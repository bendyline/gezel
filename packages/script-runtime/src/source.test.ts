import { ScriptTemplateIdSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { parseScriptMeta } from './meta.js';
import {
  computeScriptDiagnostics,
  craftbookScriptErrors,
  scaffoldScript,
  validateCraftbookScripts,
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

  it('allows ambient enums and namespaces, which erase entirely', () => {
    const diags = computeScriptDiagnostics(
      `${VALID}\ndeclare enum Mode { A, B }\ndeclare namespace N { const x: number; }\n`,
      's.ts',
    );
    expect(diags.filter((d) => d.source === 'runtime-compat')).toEqual([]);
  });

  it('flags namespaces with runtime code but allows type-only namespaces', () => {
    const runtime = computeScriptDiagnostics(
      `${VALID}\nnamespace N { export const x = 1; }\n`,
      's.ts',
    );
    expect(runtime.some((d) => d.source === 'runtime-compat')).toBe(true);

    const typeOnly = computeScriptDiagnostics(
      `${VALID}\nnamespace N { export type T = string; export interface I { a: 1 } }\n`,
      's.ts',
    );
    expect(typeOnly.filter((d) => d.source === 'runtime-compat')).toEqual([]);
  });

  it('looks through nested namespaces for runtime code', () => {
    const nestedRuntime = computeScriptDiagnostics(
      `${VALID}\nnamespace A { namespace B { export const x = 1; } }\n`,
      's.ts',
    );
    expect(nestedRuntime.some((d) => d.source === 'runtime-compat')).toBe(true);

    const nestedTypes = computeScriptDiagnostics(
      `${VALID}\nnamespace A.B { export type T = string; }\n`,
      's.ts',
    );
    expect(nestedTypes.filter((d) => d.source === 'runtime-compat')).toEqual([]);
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

  it('allows constructors whose parameters are plain', () => {
    const diags = computeScriptDiagnostics(
      `${VALID}\nclass C { x: number; constructor(x: number) { this.x = x; } }\n`,
      's.ts',
    );
    expect(diags.filter((d) => d.source === 'runtime-compat')).toEqual([]);
  });

  it('flags export = but not export default', () => {
    const exportEquals = computeScriptDiagnostics(`${VALID}\nexport = 1;\n`, 's.ts');
    expect(
      exportEquals.some((d) => d.source === 'runtime-compat' && d.message.includes('export =')),
    ).toBe(true);

    const exportDefault = computeScriptDiagnostics(`${VALID}\nexport default 1;\n`, 's.ts');
    expect(exportDefault.filter((d) => d.source === 'runtime-compat')).toEqual([]);
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

  it('errors on a re-export from fs', () => {
    const diags = computeScriptDiagnostics(
      `export { readFileSync } from 'node:fs';\n${VALID}`,
      'sample.ts',
      'sample',
    );
    expect(diags.some((d) => d.source === 'runtime-compat' && d.message.includes('node:fs'))).toBe(
      true,
    );
  });

  it("allows 'path' and other pure builtins", () => {
    const diags = computeScriptDiagnostics(
      `import { join } from 'node:path';\n${VALID}`,
      'sample.ts',
      'sample',
    );
    expect(diags).toEqual([]);
  });

  it('ignores a dynamic import whose specifier is not a literal', () => {
    const diags = computeScriptDiagnostics(
      `${VALID}\nconst name = 'node:fs';\nconst fs = await import(name);\n`,
      'sample.ts',
      'sample',
    );
    expect(diags.filter((d) => d.source === 'runtime-compat')).toEqual([]);
  });
});

describe('validateCraftbookScripts', () => {
  it('returns an empty diagnostic list for a script whose meta.name matches its key', () => {
    expect(validateCraftbookScripts({ sample: VALID })).toEqual([
      { name: 'sample', diagnostics: [] },
    ]);
  });

  it('makes a key/meta.name mismatch an error, not a warning', () => {
    const [result] = validateCraftbookScripts({ renamed: VALID });
    expect(result?.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        source: 'meta',
        message: expect.stringContaining('scripts map key is "renamed"'),
      }),
    ]);
  });

  it('reports a broken meta once, through the shared pipeline', () => {
    const [result] = validateCraftbookScripts({ broken: 'const x = 1;\n' });
    expect(result?.diagnostics.filter((d) => d.source === 'meta')).toHaveLength(1);
  });
});

describe('craftbookScriptErrors', () => {
  it('formats only error-severity diagnostics, anchored when a position is known', () => {
    const errors = craftbookScriptErrors({
      sample: VALID,
      renamed: VALID,
      enums: `${VALID.replace("name: 'sample'", "name: 'enums'")}\nenum Mode { A }\n`,
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^script "renamed": meta\.name is "sample"/);
    expect(errors[1]).toMatch(/^script "enums" \(line \d+:\d+\): enums are not supported/);
  });

  it('returns nothing for a clean map', () => {
    expect(craftbookScriptErrors({ sample: VALID })).toEqual([]);
  });
});

describe('scaffoldScript', () => {
  it('falls back to a placeholder description when none (or a too-short one) is given', () => {
    for (const description of [undefined, 'short']) {
      const source = scaffoldScript('my-script', description);
      expect(parseScriptMeta(source, 'my-script.ts').description).toBe(
        'Describe what my-script does for teammates browsing the script list.',
      );
    }
  });

  it('escapes quotes, backslashes and newlines so the scaffold still parses', () => {
    const description = "It's a C:\\path\nacross lines";
    const source = scaffoldScript('my-script', description, 'check-files');
    expect(parseScriptMeta(source, 'my-script.ts').description).toBe(
      "It's a C:\\path across lines",
    );
    expect(computeScriptDiagnostics(source, 'my-script.ts', 'my-script')).toEqual([]);
  });
});
