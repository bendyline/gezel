import { describe, expect, it } from 'vitest';
import { extractCodeSymbols } from './symbols.js';

describe('extractCodeSymbols (Scala)', () => {
  it('runs in the isolated integration lane', ({ task }) => {
    expect(task.file.projectName).toBe('integration');
  });

  it('extracts traits, objects, and classes', async () => {
    const code = [
      'trait Greeter {',
      '  def greet(name: String): String',
      '}',
      'object Main {',
      '  def run(): Unit = ()',
      '}',
      'class Shop(name: String)',
    ].join('\n');
    const syms = await extractCodeSymbols('scala', code);
    expect(syms).not.toBeNull();
    const kinds = new Map(syms!.map((s) => [s.name, s.kind]));
    expect(kinds.get('Greeter')).toBe('trait');
    expect(kinds.get('Main')).toBe('object');
    expect(kinds.get('Shop')).toBe('class');
  });
});
