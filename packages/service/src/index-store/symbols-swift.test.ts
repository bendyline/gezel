import { describe, expect, it } from 'vitest';
import { extractCodeSymbols } from './symbols.js';

describe('extractCodeSymbols (Swift)', () => {
  it('runs in the isolated integration lane', ({ task }) => {
    expect(task.file.projectName).toBe('integration');
  });

  it('extracts protocols, classes, and functions', async () => {
    const code = [
      'protocol Drawable {',
      '  func draw()',
      '}',
      'class Circle {',
      '  func draw() {}',
      '}',
      'func area(radius: Double) -> Double { return 3.14 * radius * radius }',
    ].join('\n');
    const syms = await extractCodeSymbols('swift', code);
    expect(syms).not.toBeNull();
    const kinds = new Map(syms!.map((s) => [s.name, s.kind]));
    expect(kinds.get('Circle')).toBe('class');
    expect(kinds.get('area')).toBe('function');
    expect(kinds.get('Drawable')).toBe('protocol');
  });
});
