import { describe, expect, it } from 'vitest';

import { validateSourceContent } from './source-validation.js';
import {
  normalizeWorkspaceWriteContent,
  stripExactReadFileGutters,
} from './workspace-write-normalization.js';

describe('normalizeWorkspaceWriteContent', () => {
  it('removes an exact sequential readFile gutter from a complete TypeScript rewrite', () => {
    const rendered = [
      "1→type State = 'draft' | 'paid';",
      ' 2→',
      ' 3→export function current(): State {',
      " 4→  return 'draft';",
      ' 5→}',
      '',
    ].join('\n');
    const expected = [
      "type State = 'draft' | 'paid';",
      '',
      'export function current(): State {',
      "  return 'draft';",
      '}',
      '',
    ].join('\n');

    const normalized = normalizeWorkspaceWriteContent('src/machine.ts', rendered);
    expect(normalized).toBe(expected);
    expect(validateSourceContent('src/machine.ts', normalized)).toEqual({ ok: true });
  });

  it('preserves CRLF and the final newline while removing exact gutters', () => {
    const rendered = '1→const one = 1;\r\n2→const two = 2;\r\n';
    expect(stripExactReadFileGutters('src/counts.js', rendered)).toBe(
      'const one = 1;\r\nconst two = 2;\r\n',
    );
  });

  it('does not alter partial, non-sequential, or prose-file arrow prefixes', () => {
    const partial = '1→const one = 1;\nconst two = 2;\n';
    const skipped = '1→const one = 1;\n3→const two = 2;\n';
    const markdown = '1→ first implication\n2→ second implication\n';

    expect(stripExactReadFileGutters('src/counts.ts', partial)).toBe(partial);
    expect(stripExactReadFileGutters('src/counts.ts', skipped)).toBe(skipped);
    expect(stripExactReadFileGutters('notes.md', markdown)).toBe(markdown);
  });

  it('repairs extra closing parens on if-condition lines only when the HTML parses', () => {
    const html = [
      '<!DOCTYPE html><html><body><script>',
      "if (keys['ArrowUp'] || keys['W'])) y -= speed;",
      "if (keys['ArrowDown'] || keys['S'])) y += speed;",
      '</script></body></html>',
    ].join('\n');

    const normalized = normalizeWorkspaceWriteContent('index.html', html);
    expect(normalized).toContain("if (keys['ArrowUp'] || keys['W']) y -= speed;");
    expect(normalized).toContain("if (keys['ArrowDown'] || keys['S']) y += speed;");
    expect(validateSourceContent('index.html', normalized)).toEqual({ ok: true });
  });

  it('leaves unrelated parse errors alone', () => {
    const html = [
      '<!DOCTYPE html><html><body><script>',
      'function broken( {',
      '</script></body></html>',
    ].join('\n');

    const normalized = normalizeWorkspaceWriteContent('index.html', html);
    expect(normalized).toBe(html);
  });

  it('repairs observed Gemma identifier typos before append validation', () => {
    const html = [
      '<!DOCTYPE html><html><body><script>',
      'this\\u{1f3fc}.vy = Math.sin(angle) * this.speed;',
      'this.y = Math. serat(this.radius, Math.min(canvas.height - this.radius, this.y));',
      '</script></body></html>',
    ].join('\n');

    const actual = html.replace('\\u{1f3fc}', '\u{1f3fc}');
    const normalized = normalizeWorkspaceWriteContent('index.html', actual);
    expect(normalized).toContain('this.vy = Math.sin(angle) * this.speed;');
    expect(normalized).toContain(
      'this.y = Math.max(this.radius, Math.min(canvas.height - this.radius, this.y));',
    );
    expect(validateSourceContent('index.html', normalized)).toEqual({ ok: true });
  });

  it('repairs extra canvas context parens and observed player identifier typos', () => {
    const html = [
      '<!DOCTYPE html><html><body><canvas id="c"></canvas><script>',
      "const canvas = document.getElementById('c');",
      "const ctx = canvas.getContext('2d'));",
      'class Tank { constructor(x, y) { this.x = x; this.y = y; } }',
      'const player = new Tank(10, 20));',
      'const angle = Math.atan2(playerice.y - 5, player.x - 5);',
      'alert(\\"Game Over! Score: \\" + 10);',
      'ctx.fillText(String(angle), player.x, player.y);',
      '</script></body></html>',
    ].join('\n');

    const normalized = normalizeWorkspaceWriteContent('index.html', html);
    expect(normalized).toContain("const ctx = canvas.getContext('2d');");
    expect(normalized).toContain('const player = new Tank(10, 20);');
    expect(normalized).toContain('Math.atan2(player.y - 5, player.x - 5)');
    expect(normalized).toContain('alert("Game Over! Score: " + 10);');
    expect(validateSourceContent('index.html', normalized)).toEqual({ ok: true });
  });

  it('repairs extra block-call closers when that makes the full HTML parse', () => {
    const html = [
      '<!DOCTYPE html><html><body><canvas></canvas><script>',
      'const items = [1];',
      'for (let i = 0; i < items.length; i++) {',
      '  if (items[i]) { items[i]++; }',
      '});',
      'items.forEach((item) => {',
      '  console.log(item);',
      '});});',
      '</script></body></html>',
    ].join('\n');

    const normalized = normalizeWorkspaceWriteContent('index.html', html);
    expect(normalized).toContain('for (let i = 0; i < items.length; i++) {\n  if');
    expect(normalized).toContain('}\nitems.forEach');
    expect(normalized).toContain('console.log(item);\n});\n</script>');
    expect(validateSourceContent('index.html', normalized)).toEqual({ ok: true });
  });

  it('repairs compound-assignment parens and missing forEach arrows', () => {
    const html = [
      '<!DOCTYPE html><html><body><canvas></canvas><script>',
      'const projectiles = [];',
      'const enemies = [{ x: 0, y: 0, radius: 10 }, { x: 5, y: 5, radius: 10 }];',
      'const player = { x: 10, y: 10, speed: 3 };',
      'const dy = 1;',
      'player.y += (dy/player.speed) * thiss.speed);',
      'enemies.forEach((e, ei) => {',
      '  enemies.forEach((e2, ei2)) {',
      '    const dist = Math.sqrt((e.x-e2.x)**2 + (e.y-e2.y)**2));',
      '    if (dist < e.radius) projectile.splice(ei, 1);',
      '  });',
      '});',
      '</script></body></html>',
    ].join('\n');

    const normalized = normalizeWorkspaceWriteContent('index.html', html);
    expect(normalized).toContain('player.y += (dy/player.speed) * this.speed;');
    expect(normalized).toContain('enemies.forEach((e2, ei2) => {');
    expect(normalized).toContain('const dist = Math.sqrt((e.x-e2.x)**2 + (e.y-e2.y)**2);');
    expect(normalized).toContain('projectiles.splice(ei, 1);');
    expect(validateSourceContent('index.html', normalized)).toEqual({ ok: true });
  });
});
