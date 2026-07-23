import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findGezmodelArguments, portableGezmodelFilename } from './model-bundle-files.js';

describe('model bundle OS argument parsing', () => {
  it('finds case-insensitive absolute and relative .gezmodel paths', () => {
    const cwd = resolve('fixtures');
    expect(findGezmodelArguments(['gezel', 'one.gezmodel', 'two.GEZMODEL', '--flag'], cwd)).toEqual(
      [resolve(cwd, 'one.gezmodel'), resolve(cwd, 'two.GEZMODEL')],
    );
  });

  it('ignores unrelated arguments and creates a portable export name', () => {
    expect(findGezmodelArguments(['gezel', '--gezel-home=C:/tmp'], 'C:/work')).toEqual([]);
    expect(portableGezmodelFilename('qwen:7b/q4')).toBe('qwen-7b-q4.gezmodel');
  });
});
