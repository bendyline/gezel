import { describe, expect, it } from 'vitest';
import { extractCodeSymbols } from './symbols.js';

describe('extractCodeSymbols (Kotlin)', () => {
  it('runs in the isolated integration lane', ({ task }) => {
    expect(task.file.projectName).toBe('integration');
  });

  it('extracts classes, objects, and functions', async () => {
    const code = [
      'class Winkel(val name: String) {',
      '  fun open() {}',
      '}',
      'object Register {',
      '  fun total(): Int = 0',
      '}',
      'fun main() {}',
    ].join('\n');
    const syms = await extractCodeSymbols('kotlin', code);
    expect(syms).not.toBeNull();
    const kinds = new Map(syms!.map((s) => [s.name, s.kind]));
    expect(kinds.get('Winkel')).toBe('class');
    expect(kinds.get('Register')).toBe('object');
    expect(kinds.get('main')).toBe('function');
  });
});
