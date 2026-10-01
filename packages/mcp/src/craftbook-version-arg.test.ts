import { describe, expect, it } from 'vitest';
import { resolveCraftbookVersionArg } from './craftbook-version-arg.js';

const OFFERED = ['1.0.0', '1.1.0', '1.2.6'];

describe('resolveCraftbookVersionArg', () => {
  it('drops a version the book does not offer instead of failing the launch', () => {
    expect(resolveCraftbookVersionArg('1.0', OFFERED)).toEqual({ ignored: '1.0' });
  });

  it('keeps an exact pin the book offers', () => {
    expect(resolveCraftbookVersionArg(' 1.1.0 ', OFFERED)).toEqual({ version: '1.1.0' });
  });

  it('means latest when the version is absent or blank', () => {
    expect(resolveCraftbookVersionArg(undefined, OFFERED)).toEqual({});
    expect(resolveCraftbookVersionArg('  ', OFFERED)).toEqual({});
  });

  it('passes the value through when the listing reported no versions', () => {
    expect(resolveCraftbookVersionArg('9.9.9', [])).toEqual({ version: '9.9.9' });
  });
});
