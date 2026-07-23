import { describe, expect, it } from 'vitest';
import { redactObject, redactString } from './mcp-bridge.js';

describe('redactString', () => {
  it('is a no-op when the secret set is empty', () => {
    expect(redactString('ghp_abcdef', new Set())).toBe('ghp_abcdef');
  });

  it('replaces a single known secret with [REDACTED]', () => {
    const out = redactString('auth failed: Bearer ghp_abcdef rejected', new Set(['ghp_abcdef']));
    expect(out).toBe('auth failed: Bearer [REDACTED] rejected');
  });

  it('replaces multiple known secrets', () => {
    const out = redactString('token=ghp_xxx org=acme-secret', new Set(['ghp_xxx', 'acme-secret']));
    expect(out).toBe('token=[REDACTED] org=[REDACTED]');
  });

  it('ignores empty secret values in the set', () => {
    const out = redactString('hello', new Set(['']));
    expect(out).toBe('hello');
  });
});

describe('redactObject', () => {
  it('redacts string values anywhere in the object graph', () => {
    const input = {
      name: 'callTool',
      args: { path: 'README.md', token: 'ghp_xxx' },
      nested: [{ header: 'Bearer ghp_xxx' }],
    };
    const out = redactObject(input, new Set(['ghp_xxx']));
    expect(out).toEqual({
      name: 'callTool',
      args: { path: 'README.md', token: '[REDACTED]' },
      nested: [{ header: 'Bearer [REDACTED]' }],
    });
  });

  it('leaves numbers, booleans, and null untouched', () => {
    const input = { n: 42, b: true, z: null };
    expect(redactObject(input, new Set(['ghp_xxx']))).toEqual(input);
  });
});
