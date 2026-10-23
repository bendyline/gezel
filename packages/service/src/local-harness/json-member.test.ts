import { describe, expect, it } from 'vitest';
import { readJsonMember, removeJsonMember, upsertJsonMember } from './json-member.js';

const ENTRY = { command: 'node', args: ['launch.mjs', '--harness', 'cursor'] };

describe('JSON member splicing', () => {
  it('creates the file when there is none', () => {
    const out = upsertJsonMember(null, ['mcpServers', 'gezel'], ENTRY);
    expect(JSON.parse(out)).toEqual({ mcpServers: { gezel: ENTRY } });
  });

  it('adds the entry beside others and keeps comments and formatting', () => {
    const before = `{
  // my servers
  "mcpServers": {
    "github": { "command": "gh-mcp" } // keep me
  },
  "theme": "dark"
}
`;
    const out = upsertJsonMember(before, ['mcpServers', 'gezel'], ENTRY);
    expect(out).toContain('// my servers');
    expect(out).toContain('"github": { "command": "gh-mcp" }, // keep me');
    expect(out).toContain('"theme": "dark"');
    expect(readJsonMember(out, ['mcpServers', 'gezel'])).toEqual(ENTRY);
    expect(readJsonMember(out, ['mcpServers', 'github'])).toEqual({ command: 'gh-mcp' });
  });

  it('creates the parent object when only other settings exist', () => {
    const out = upsertJsonMember('{\n  "theme": "dark"\n}\n', ['servers', 'gezel'], ENTRY);
    expect(readJsonMember(out, ['servers', 'gezel'])).toEqual(ENTRY);
    expect(readJsonMember(out, ['theme'])).toBe('dark');
  });

  it('replaces only the entry it owns', () => {
    const before = `{"mcpServers": {"a": 1, "gezel": {"command": "old"}, "b": [1, {"x": 2}]}}`;
    const out = upsertJsonMember(before, ['mcpServers', 'gezel'], ENTRY);
    expect(readJsonMember(out, ['mcpServers'])).toEqual({ a: 1, gezel: ENTRY, b: [1, { x: 2 }] });
  });

  it('removes the entry in any position and leaves valid JSON', () => {
    for (const before of [
      '{"mcpServers": {"gezel": {"command": "x"}, "a": 1}}',
      '{"mcpServers": {"a": 1, "gezel": {"command": "x"}}}',
      '{"mcpServers": {"gezel": {"command": "x"}}}',
      '{\n  "mcpServers": {\n    "a": 1,\n    "gezel": { "command": "x" },\n    "b": 2\n  }\n}',
    ]) {
      const out = removeJsonMember(before, ['mcpServers', 'gezel']);
      expect(readJsonMember(out, ['mcpServers', 'gezel']), before).toBeUndefined();
      expect(() => JSON.parse(out), out).not.toThrow();
    }
  });

  it('reads JSONC with trailing commas, and refuses a file that is not an object', () => {
    expect(
      readJsonMember('{"servers": {"gezel": {"args": ["a",],},},}', ['servers', 'gezel']),
    ).toEqual({
      args: ['a'],
    });
    expect(() => upsertJsonMember('[1, 2]', ['servers', 'gezel'], ENTRY)).toThrow(
      /not a JSON object/,
    );
    expect(() => upsertJsonMember('{"servers": 3}', ['servers', 'gezel'], ENTRY)).toThrow(
      /not an object/,
    );
  });

  it('keeps Windows paths intact', () => {
    const windows = {
      command: 'C:\\Users\\me\\.gezel\\bin\\node.exe',
      args: ['C:\\x\\launch.mjs'],
    };
    const out = upsertJsonMember('{}', ['mcpServers', 'gezel'], windows);
    expect(readJsonMember(out, ['mcpServers', 'gezel'])).toEqual(windows);
  });
});
