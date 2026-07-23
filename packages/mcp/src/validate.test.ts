import { describe, expect, it } from 'vitest';
import { type FileContent, formatValidateResult, validateFile } from './validate.js';

function textContent(text: string): FileContent {
  const bytes = new TextEncoder().encode(text);
  return { text, bytes, totalBytes: bytes.byteLength };
}

function binaryContent(bytes: number[]): FileContent {
  const buf = new Uint8Array(bytes);
  return { bytes: buf, totalBytes: buf.byteLength };
}

describe('validateFile — HTML', () => {
  it('passes a well-formed HTML page with one inline <script>', () => {
    const html =
      '<!DOCTYPE html><html><body><script>\nconst x = 1;\nconsole.log(x);\n</script></body></html>';
    const r = validateFile('workspace/index.html', textContent(html));
    expect(r.checks.every((c) => c.ok)).toBe(true);
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/PASS/);
    expect(formatted).toContain('script-body-parses');
  });

  it('fails on unbalanced <script> tags (truncated mid-script)', () => {
    const html =
      '<!DOCTYPE html><html><body><script>\nconst x = 1;\nfunction reset() {\n  board = [];';
    const r = validateFile('workspace/index.html', textContent(html));
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/FAIL/);
    expect(formatted).toMatch(/script-tag-balanced/);
    expect(formatted).toMatch(/Fix hint:/);
  });

  it('fails with a code excerpt + line number when an inline script does not parse', () => {
    const html = [
      '<!DOCTYPE html>',
      '<html>',
      '<body>',
      '<script>',
      'function reset() {',
      '  board = [',
      '  // missing close bracket',
      '}', // unexpected }
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
    const r = validateFile('workspace/index.html', textContent(html));
    const failed = r.checks.find((c) => !c.ok);
    expect(failed).toBeDefined();
    expect(failed?.ok).toBe(false);
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/FAIL/);
    expect(formatted).toMatch(/at line \d+/);
    // Excerpt should include a `← here` marker on the failing line
    expect(formatted).toContain('← here');
    // Excerpt should have line-number gutter
    expect(formatted).toMatch(/\d+ \|/);
  });

  it('reports missing-script with an actionable fix hint on a static HTML page', () => {
    const html = '<!DOCTYPE html><html><body><h1>Hi</h1></body></html>';
    const r = validateFile('workspace/index.html', textContent(html));
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/script-tag-present/);
    expect(formatted).toMatch(/no inline <script>/);
  });
});

describe('validateFile — JS/TS', () => {
  it('passes a syntactically valid JS file', () => {
    const js = 'const x = 1;\nfunction foo() { return x; }\n';
    const r = validateFile('workspace/lib.js', textContent(js));
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/PASS/);
    expect(formatted).toMatch(/parses/);
  });

  it('fails with line/col + excerpt on a JS syntax error', () => {
    const js = 'const x = 1;\nfunction broken( {\n  return 2;\n}\n';
    const r = validateFile('workspace/broken.js', textContent(js));
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/FAIL/);
    expect(formatted).toMatch(/at line \d+/);
    expect(formatted).toContain('← here');
  });

  it('fails with a module-syntax hint for static imports inside functions', () => {
    const js = "export function render() {\n  import { tasks } from './state.js';\n}\n";
    const r = validateFile('workspace/src/render.js', textContent(js));
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/FAIL/);
    expect(formatted).toContain('module-syntax');
    expect(formatted).toContain('static import/export declarations are only valid');
    expect(formatted).toContain('Fix hint: move this import/export to the top of the file');
  });

  it('passes a TS file with type annotations (parser only, no type-check)', () => {
    const ts =
      'const x: number = 1;\nfunction add(a: number, b: number): number { return a + b; }\n';
    const r = validateFile('workspace/lib.ts', textContent(ts));
    expect(formatValidateResult(r)).toMatch(/PASS/);
  });
});

describe('validateFile — JSON', () => {
  it('passes valid JSON', () => {
    const r = validateFile('workspace/data.json', textContent('{"a": 1, "b": [2, 3]}'));
    expect(formatValidateResult(r)).toMatch(/PASS/);
  });

  it('fails on a syntax error with line/col + excerpt', () => {
    const r = validateFile('workspace/data.json', textContent('{\n  "a": 1,\n  ,\n  "b": 2\n}'));
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/FAIL/);
    expect(formatted).toContain('parses');
    expect(formatted).toContain('← here');
  });
});

describe('validateFile — images', () => {
  // petshop case: model wrote a 4-byte logo.png via writeFile.
  // The verification gate now requires evidence; the model would call
  // validate first and learn the file is corrupt + the fix is to use
  // copy_artifact_to_workspace.
  it('fails with the copy_artifact_to_workspace hint on a 4-byte PNG (the petshop case)', () => {
    const r = validateFile('workspace/assets/logo.png', binaryContent([0xc3, 0x84, 0xc2, 0xa2]));
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/FAIL/);
    expect(formatted).toMatch(/magic-bytes/);
    expect(formatted).toMatch(/bytes-min/);
    expect(formatted).toMatch(/copy_artifact_to_workspace/);
    // Cite the actual bytes so the model can correlate
    expect(formatted).toMatch(/c3 84 c2 a2/);
    // Cite the expected magic
    expect(formatted).toMatch(/89 50 4e 47/);
  });

  it('passes a real PNG header (89 50 4E 47 0D 0A 1A 0A + 100 bytes pad)', () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(120).fill(0)];
    const r = validateFile('workspace/icon.png', binaryContent(bytes));
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/PASS/);
    expect(formatted).toMatch(/valid PNG header/);
  });

  it('fails JPEG with wrong magic-bytes', () => {
    const bytes = [0x00, 0x00, 0x00, ...new Array(120).fill(0)];
    const r = validateFile('workspace/icon.jpg', binaryContent(bytes));
    expect(formatValidateResult(r)).toMatch(/not a valid JPEG/);
  });

  it('passes WebP with RIFF + WEBP markers', () => {
    const bytes = [
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x00,
      0x00,
      0x00,
      0x00, // size
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
      ...new Array(120).fill(0),
    ];
    const r = validateFile('workspace/pic.webp', binaryContent(bytes));
    expect(formatValidateResult(r)).toMatch(/PASS/);
  });

  it('passes SVG starting with <svg', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';
    const bytes = new TextEncoder().encode(svg);
    const r = validateFile('workspace/icon.svg', {
      bytes,
      text: svg,
      totalBytes: bytes.byteLength,
    });
    expect(formatValidateResult(r)).toMatch(/PASS/);
  });
});

describe('validateFile — formatting', () => {
  it('puts failures first and passes after, with summary on top', () => {
    const html = [
      '<html><body>',
      '<script>',
      'const x = ;', // syntax error
      '</script>',
      '</body></html>',
    ].join('\n');
    const r = validateFile('workspace/x.html', textContent(html));
    const formatted = formatValidateResult(r);
    const lines = formatted.split('\n');
    // First line is the summary
    expect(lines[0]).toMatch(/^validate .* — FAIL/);
    // Failures use ✗
    expect(formatted).toContain('✗');
    // Passes use ✓
    expect(formatted).toContain('✓');
    // ✗ comes before ✓ in the output (failures-first)
    expect(formatted.indexOf('✗')).toBeLessThan(formatted.indexOf('✓'));
  });

  it('passes-only output is a one-line summary plus a one-line per check', () => {
    const r = validateFile('workspace/x.json', textContent('{"a": 1}'));
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/PASS/);
    expect(formatted).not.toContain('Fix hint:');
    expect(formatted).not.toContain('← here');
  });
});

describe('validateFile — unknown extensions', () => {
  it('returns a single file-non-empty check on unknown extensions', () => {
    const r = validateFile('workspace/notes.xyz', textContent('hello'));
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]?.name).toBe('file-non-empty');
  });

  it('flags empty files as non-empty failure with a fix hint', () => {
    const r = validateFile('workspace/notes.xyz', {
      bytes: new Uint8Array(0),
      totalBytes: 0,
    });
    const formatted = formatValidateResult(r);
    expect(formatted).toMatch(/FAIL/);
    expect(formatted).toMatch(/file is empty/);
  });
});
