import { describe, expect, it } from 'vitest';
import { assertSafeEntityId, isSafeEntityId } from './entity-id.js';

describe('filesystem entity ids', () => {
  it.each(['default', 'project-2', 'proj__alpha__reviewer', '@project', 'abc.123'])(
    'accepts the portable id %s',
    (id) => expect(isSafeEntityId(id)).toBe(true),
  );

  it.each([
    '..',
    '.',
    '../outside',
    '..\\outside',
    '/absolute',
    'C:\\outside',
    'with space',
    'with/slash',
    'with\\slash',
    'CON',
    'nul.txt',
    '',
  ])('rejects the unsafe id %s', (id) => expect(isSafeEntityId(id)).toBe(false));

  it('throws at defensive path-helper boundaries', () => {
    expect(() => assertSafeEntityId('../outside', 'project id')).toThrow(/project id/);
  });
});
