import { describe, expect, it } from 'vitest';
import { FindFilesRequestSchema } from './api.js';
import {
  FILE_GLOB_MAX_DEPTH,
  FILE_GLOB_MAX_EXPANSIONS,
  FILE_GLOB_MAX_LENGTH,
  FileGlobSchema,
} from './file-glob.js';

describe('FileGlobSchema', () => {
  it.each([
    '**/*.spec.ts',
    '**/*.{ts,tsx}',
    'src/{client,{core,sdk}}/**/*.ts',
    '**/*.+(ts|tsx)',
    'file-[0-9].txt',
    '[{}].txt',
    'literal\\{name\\}.txt',
    'file-{1..10}.txt',
    'file-{10..1..2}.txt',
    'file-{a..z}.txt',
    'file-{-2..2}.txt',
    '{1..1000000,literal}.txt',
  ])('accepts a bounded ordinary glob: %s', (glob) => {
    expect(FindFilesRequestSchema.parse({ glob }).glob).toBe(glob);
  });

  it('bounds length before inspecting the original stack-exhaustion payload', () => {
    expect(FileGlobSchema.safeParse('x'.repeat(FILE_GLOB_MAX_LENGTH)).success).toBe(true);
    expect(FileGlobSchema.safeParse('x'.repeat(FILE_GLOB_MAX_LENGTH + 1)).success).toBe(false);
    expect(FileGlobSchema.safeParse(`${'{'.repeat(4999)}x${'}'.repeat(4999)}`).success).toBe(false);
  });

  it.each(['{', '(', '['])('bounds parser nesting independently of length: %s', (open) => {
    const close = open === '{' ? '}' : open === '(' ? ')' : ']';
    const atLimit = `${open.repeat(FILE_GLOB_MAX_DEPTH)}x${close.repeat(FILE_GLOB_MAX_DEPTH)}`;
    expect(FileGlobSchema.safeParse(atLimit).success).toBe(true);
    expect(FileGlobSchema.safeParse(`${open}${atLimit}${close}`).success).toBe(false);
  });

  it('bounds Cartesian products, nested choices, and ranges before expansion', () => {
    expect(FileGlobSchema.safeParse('{a,b}'.repeat(7)).success).toBe(true);
    expect(FileGlobSchema.safeParse('{a,b}'.repeat(8)).success).toBe(false);
    expect(FileGlobSchema.safeParse('{a,{b,c}}'.repeat(5)).success).toBe(false);
    expect(FileGlobSchema.safeParse(`{1..${FILE_GLOB_MAX_EXPANSIONS}}`).success).toBe(true);
    expect(FileGlobSchema.safeParse(`{1..${FILE_GLOB_MAX_EXPANSIONS + 1}}`).success).toBe(false);
    expect(FileGlobSchema.safeParse('{1..12}{1..12}').success).toBe(false);
    expect(FileGlobSchema.safeParse('{1..1000000000..1000000000}').success).toBe(false);
  });

  it('does not let quoted closing braces hide actual AST nesting', () => {
    const disguised = '{"}"'.repeat(9) + '"{"}'.repeat(9);
    expect(FileGlobSchema.safeParse(disguised).success).toBe(false);
    expect(FileGlobSchema.safeParse('"{literal,braces}".txt').success).toBe(true);
  });

  it.each([
    '',
    '**/*.{ts,tsx',
    '**/*.(ts|tsx}',
    'file-[0-9',
    'file-\\',
    'file-\u0000',
    '{1.\u00a0.1000000}',
    '{1.\ufeff.1000000}',
    '{1..9007199254740992}',
    '{1..10..0}',
    '{a..10}',
    '{1..2..3..4}',
    '{"1".."1000000"}',
  ])('rejects malformed or disguised parser inputs: %j', (glob) => {
    expect(FileGlobSchema.safeParse(glob).success).toBe(false);
  });

  it('keeps the request result cap in the shared contract', () => {
    expect(FindFilesRequestSchema.safeParse({ glob: '**/*', maxResults: 5000 }).success).toBe(true);
    expect(FindFilesRequestSchema.safeParse({ glob: '**/*', maxResults: 5001 }).success).toBe(
      false,
    );
  });
});
