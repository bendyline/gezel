import { describe, expect, it } from 'vitest';
import type { ScriptMeta } from '../schemas/script.js';
import {
  formValueToMeta,
  metaToFormValue,
  parseMetaObject,
  serializeScriptMeta,
  setupLineSpan,
  splitScriptSource,
  stitchScriptSource,
} from './source-split.js';

/**
 * The six scaffold templates, inlined verbatim from
 * packages/service/src/scripts/source.ts so split→stitch round-trips can be
 * asserted byte-for-byte without importing the service (node-only) package.
 */
const SCAFFOLD_BLANK = `import { defineScript, gezel, type InferredInput } from '@bendyline/gezel-sdk';

// Every script exports a meta block: it names the script, declares what
// it takes and produces, and lists the capabilities it may use. The
// service enforces the capability list at call time.
export const meta = defineScript({
  name: 'build-enter',
  description: 'Describe what build-enter does for teammates browsing the script list.',
  inputs: {
    example: { type: 'string', description: 'Example input — replace or remove.', default: 'hello' },
  },
  outputs: {
    ok: { type: 'boolean', description: 'Whether the script succeeded.' },
  },
  requires: [],
});

// gezel.input is the validated input; this cast gives it the exact type
// inferred from the meta block above.
const input = gezel.input as InferredInput<typeof meta>;

gezel.log('running with', input.example);

// Every script stamps exactly one output before it finishes.
gezel.output({ ok: true });
`;

const SCAFFOLD_POST_MESSAGE = `import { defineScript, gezel, type InferredInput } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'post-note',
  description: 'Posts a note to a task.',
  inputs: {
    taskRef: { type: 'string', description: 'Task to post to, as "projectId/num".', required: true },
    message: { type: 'string', description: 'The note to post.', required: true, multiline: true },
  },
  outputs: {
    posted: { type: 'boolean', description: 'Whether the note was written.' },
  },
  requires: ['tasks.write'],
});

const input = gezel.input as InferredInput<typeof meta>;

await gezel.task.writeNotes(input.taskRef, input.message);
gezel.output({ posted: true });
`;

describe('splitScriptSource / stitchScriptSource', () => {
  it('splits the blank scaffold into preamble, meta, and body', () => {
    const s = splitScriptSource(SCAFFOLD_BLANK);
    expect(s.found).toBe(true);
    expect(s.preamble).toContain('import { defineScript');
    expect(s.preamble).not.toContain('export const meta');
    expect(s.metaLeadingComment).toContain('Every script exports a meta block');
    expect(s.metaText.startsWith('export const meta = defineScript({')).toBe(true);
    expect(s.metaText.trimEnd().endsWith('});')).toBe(true);
    expect(s.metaText).not.toContain('const input');
    expect(s.body).toContain('const input = gezel.input');
    expect(s.body).toContain('gezel.output({ ok: true })');
  });

  it('round-trips the scaffolds byte-for-byte through split → stitch', () => {
    for (const scaffold of [SCAFFOLD_BLANK, SCAFFOLD_POST_MESSAGE]) {
      const s = splitScriptSource(scaffold);
      const rebuilt = stitchScriptSource({
        preamble: s.preamble,
        metaText: s.metaLeadingComment ? `${s.metaLeadingComment}\n${s.metaText}` : s.metaText,
        body: s.body,
      });
      expect(rebuilt).toBe(scaffold);
    }
  });

  it('reports found:false when there is no meta statement', () => {
    const s = splitScriptSource('const x = 1;\nconsole.log(x);\n');
    expect(s.found).toBe(false);
    expect(s.preamble).toContain('const x = 1');
  });

  it('takes the first meta and ignores a decoy const before it', () => {
    const src = `const exporter = 1;\nexport const metaData = 2;\nexport const meta = defineScript({ name: 'a', description: 'ten chars!' });\nconst input = 1;\n`;
    const s = splitScriptSource(src);
    expect(s.found).toBe(true);
    expect(s.metaText).toContain("name: 'a'");
    expect(s.body).toContain('const input = 1');
  });

  it('handles a semicolon inside a meta string literal', () => {
    const src = `export const meta = defineScript({ name: 'a', description: 'has a ; inside; really' });\nconst input = 1;\n`;
    const s = splitScriptSource(src);
    expect(s.found).toBe(true);
    expect(s.metaText.endsWith('});')).toBe(true);
    expect(s.body.trim()).toBe('const input = 1;');
  });

  it('handles a closing brace inside a meta string literal', () => {
    const src = `export const meta = defineScript({ name: 'a', description: 'closing } brace and ; here' });\nconst input = 2;\n`;
    const s = splitScriptSource(src);
    expect(s.metaText.endsWith('});')).toBe(true);
    expect(s.body.trim()).toBe('const input = 2;');
  });

  it('does not attach a comment separated from meta by a blank line', () => {
    const src = `// standalone note\n\nexport const meta = defineScript({ name: 'a', description: 'ten chars!!' });\n`;
    const s = splitScriptSource(src);
    expect(s.metaLeadingComment).toBe('');
    expect(s.preamble).toContain('standalone note');
  });
});

describe('setupLineSpan', () => {
  it('counts every setup line (imports + comments + meta) for the scaffolds', () => {
    // Hidden range is lines 1..span; the body must be exactly what remains.
    for (const scaffold of [SCAFFOLD_BLANK, SCAFFOLD_POST_MESSAGE]) {
      const span = setupLineSpan(scaffold);
      const lines = scaffold.split('\n');
      // The line right after the span is where the body opens (a blank line,
      // since the scaffolds separate meta and body with one); the meta's
      // closing `});` is the last hidden line.
      expect(lines[span - 1]).toBe('});');
      // Nothing past the span contains the meta statement.
      expect(lines.slice(span).join('\n')).toContain('const input = gezel.input');
      expect(lines.slice(span).join('\n')).not.toContain('export const meta');
    }
  });

  it('hides a single-line meta on line 1', () => {
    const src = `export const meta = defineScript({ name: 'a', description: 'ten chars!!' });\n\ngezel.output({});\n`;
    expect(setupLineSpan(src)).toBe(1);
  });

  it('returns 0 when there is no meta statement (nothing to hide)', () => {
    expect(setupLineSpan('const x = 1;\nconsole.log(x);\n')).toBe(0);
  });

  it('keeps body text visible when it shares the meta line (no leading newline)', () => {
    const src = `export const meta = defineScript({ name: 'a', description: 'ten chars!!' });const x = 1;`;
    // Body starts on the meta line, so we stop short rather than hide it.
    expect(setupLineSpan(src)).toBe(0);
  });
});

describe('parseMetaObject', () => {
  it('parses a defineScript-wrapped statement', () => {
    const r = parseMetaObject(
      `export const meta = defineScript({ name: 'hello', description: 'says hello!' });`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.name).toBe('hello');
  });

  it('parses an as-const wrapped object', () => {
    const r = parseMetaObject(
      `export const meta = { name: 'noop', description: 'ten chars.' } as const;`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.description).toBe('ten chars.');
  });

  it('parses inputs, outputs, and requires with trailing commas', () => {
    const r = parseMetaObject(
      `export const meta = defineScript({
        name: 'fetch-rates',
        description: 'pulls rates for a base currency',
        inputs: {
          base: { type: 'string', description: 'ISO code', required: true, pattern: '^[A-Z]{3}$' },
          source: { type: 'choice', description: 'provider', options: [{ value: 'ecb' }, { value: 'fed' }], default: 'ecb' },
        },
        outputs: {
          ok: { type: 'boolean', description: 'success flag' },
        },
        requires: ['network', 'artifacts.write'],
      });`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta.inputs?.base?.type).toBe('string');
      expect(r.meta.outputs?.ok?.type).toBe('boolean');
      expect(r.meta.requires).toEqual(['network', 'artifacts.write']);
    }
  });

  it('fails on an invalid meta (too-short description)', () => {
    const r = parseMetaObject(
      `export const meta = defineScript({ name: 'a', description: 'short' });`,
    );
    expect(r.ok).toBe(false);
  });
});

describe('serializeScriptMeta round-trips', () => {
  const fixture: ScriptMeta = {
    name: 'kitchen-sink',
    description: 'Exercises every input and output type for the round-trip test.',
    kind: 'gate',
    inputs: {
      str: {
        type: 'string',
        description: 'a string',
        required: true,
        default: 'hi',
        pattern: '^.+$',
        multiline: true,
      },
      num: { type: 'number', description: 'a number', default: 3, min: 0, max: 10, integer: true },
      bool: { type: 'boolean', description: 'a boolean', default: false },
      pick: {
        type: 'choice',
        description: 'a choice',
        default: 'x',
        options: [{ value: 'x', label: 'Ex' }, { value: 'y' }],
      },
      who: { type: 'ref', description: 'a ref', kind: 'task' },
      blob: { type: 'json', description: 'a json', default: { a: 1 }, schema: { type: 'object' } },
    },
    outputs: {
      s: { type: 'string', description: 'string out', nullable: true },
      n: { type: 'number', description: 'number out' },
      b: { type: 'boolean', description: 'bool out' },
      arr: { type: 'array', description: 'array out', itemType: 'object' },
      obj: { type: 'object', description: 'object out', schema: { type: 'object' } },
      j: { type: 'json', description: 'json out' },
    },
    requires: ['network', 'llm', 'credential:github.token'],
  };

  it('serializes then re-parses to a deep-equal meta', () => {
    const text = serializeScriptMeta(fixture);
    const r = parseMetaObject(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta).toEqual(fixture);
  });

  it('emits the canonical blank-scaffold meta block', () => {
    const meta: ScriptMeta = {
      name: 'build-enter',
      description: 'Describe what build-enter does for teammates browsing the script list.',
      inputs: {
        example: {
          type: 'string',
          description: 'Example input — replace or remove.',
          default: 'hello',
        },
      },
      outputs: {
        ok: { type: 'boolean', description: 'Whether the script succeeded.' },
      },
      requires: [],
    };
    const expected = `export const meta = defineScript({
  name: 'build-enter',
  description: 'Describe what build-enter does for teammates browsing the script list.',
  inputs: {
    example: { type: 'string', description: 'Example input — replace or remove.', default: 'hello' },
  },
  outputs: {
    ok: { type: 'boolean', description: 'Whether the script succeeded.' },
  },
  requires: [],
});`;
    expect(serializeScriptMeta(meta)).toBe(expected);
  });
});

describe('metaToFormValue / formValueToMeta', () => {
  const meta: ScriptMeta = {
    name: 'thing',
    description: 'does a thing for the round trip',
    inputs: {
      a: { type: 'string', description: 'first', required: true },
      b: { type: 'number', description: 'second', min: 1 },
      c: {
        type: 'choice',
        description: 'third',
        options: [{ value: 'p' }, { value: 'q', label: 'Q' }],
      },
      d: { type: 'json', description: 'fourth', default: { k: true } },
    },
    outputs: {
      ok: { type: 'boolean', description: 'success' },
      items: { type: 'array', description: 'list', itemType: 'string' },
    },
    requires: ['llm'],
  };

  it('round-trips meta → form value → meta', () => {
    const form = metaToFormValue(meta);
    expect(form.inputs.map((i) => i.name)).toEqual(['a', 'b', 'c', 'd']);
    const r = formValueToMeta(form);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta).toEqual(meta);
  });

  it('rejects duplicate input names', () => {
    const form = metaToFormValue(meta);
    form.inputs.push({ name: 'a', type: 'string', description: 'dup' });
    const r = formValueToMeta(form);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((m) => /Duplicate input/.test(m))).toBe(true);
  });

  it('rejects an empty input name', () => {
    const form = metaToFormValue(meta);
    form.inputs.push({ name: '   ', type: 'string', description: 'blank' });
    const r = formValueToMeta(form);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((m) => /needs a name/.test(m))).toBe(true);
  });

  it('drops keys irrelevant to the chosen type after a type switch', () => {
    const form = metaToFormValue(meta);
    // Simulate the user switching input "a" from string to boolean while a
    // stale `pattern` lingers in the form item.
    form.inputs[0] = { name: 'a', type: 'boolean', description: 'first', pattern: '^x$' as never };
    const r = formValueToMeta(form);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.inputs?.a).toEqual({ type: 'boolean', description: 'first' });
  });
});
