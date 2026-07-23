import { describe, expect, it } from 'vitest';
import {
  type DeliverableWrite,
  deliverableWrittenThisTurn,
  evaluateDeliverableGate,
  normalizeWorkspacePath,
} from './deliverable-gate.js';

const write = (over: Partial<DeliverableWrite> = {}): DeliverableWrite => ({
  name: 'writeFile',
  path: 'index.html',
  success: true,
  ...over,
});

describe('normalizeWorkspacePath', () => {
  it('strips ./ and workspace/ prefixes and normalizes slashes', () => {
    expect(normalizeWorkspacePath('./index.html')).toBe('index.html');
    expect(normalizeWorkspacePath('workspace/src/a.ts')).toBe('src/a.ts');
    expect(normalizeWorkspacePath('packages\\core\\src\\Geohash.ts')).toBe(
      'packages/core/src/Geohash.ts',
    );
    expect(normalizeWorkspacePath('/leading//double.ts')).toBe('leading/double.ts');
  });
});

describe('deliverableWrittenThisTurn', () => {
  const file = 'packages/core/src/spatial/Geohash.ts';

  it('matches a successful write tool targeting the deliverable', () => {
    expect(deliverableWrittenThisTurn([write({ name: 'replaceInFile', path: file })], file)).toBe(
      true,
    );
  });

  it('tolerates a workspace/ prefix mismatch between gate file and tool path', () => {
    expect(deliverableWrittenThisTurn([write({ path: `workspace/${file}` })], file)).toBe(true);
    expect(deliverableWrittenThisTurn([write({ path: file })], `workspace/${file}`)).toBe(true);
  });

  it('does not match a failed write', () => {
    expect(deliverableWrittenThisTurn([write({ path: file, success: false })], file)).toBe(false);
  });

  it('does not match a non-write tool (e.g. a read)', () => {
    expect(deliverableWrittenThisTurn([write({ name: 'readFile', path: file })], file)).toBe(false);
  });

  it('does not match a write to a different file', () => {
    expect(
      deliverableWrittenThisTurn([write({ path: 'packages/core/src/spatial/Haversine.ts' })], file),
    ).toBe(false);
  });

  it('does not let a suffix collide across a non-/ boundary', () => {
    // "Geohash.ts" must not match "OtherGeohash.ts".
    expect(
      deliverableWrittenThisTurn([write({ path: 'src/OtherGeohash.ts' })], 'src/Geohash.ts'),
    ).toBe(false);
  });

  it('accepts every write-shaped tool name', () => {
    for (const name of [
      'writeFile',
      'replaceInFile',
      'appendToFile',
      'applyPatch',
      'insertAtMarker',
    ]) {
      expect(deliverableWrittenThisTurn([write({ name, path: file })], file)).toBe(true);
    }
  });
});

describe('evaluateDeliverableGate', () => {
  it('holds when the deliverable does not exist', () => {
    const r = evaluateDeliverableGate({ content: null, spec: { file: 'index.html' }, writes: [] });
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain('not found');
  });

  it('holds when below minBytes', () => {
    const r = evaluateDeliverableGate({
      content: 'hi',
      spec: { file: 'index.html', minBytes: 500 },
      writes: [],
    });
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain('minBytes');
  });

  it('holds when the sniff fails', () => {
    const r = evaluateDeliverableGate({
      content: '<html><script>', // unbalanced script, no closing tag
      spec: { file: 'index.html', sniff: 'html-complete' },
      writes: [],
    });
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain('html-complete');
  });

  it('legacy behavior: presence alone is enough without requireChange', () => {
    const r = evaluateDeliverableGate({
      content: 'export const x = 1;\n',
      spec: { file: 'src/a.ts', sniff: 'nonempty' },
      writes: [], // no write this turn — still advances (new-file deliverable)
    });
    expect(r.satisfied).toBe(true);
  });

  describe('requireChange (edit gate)', () => {
    const file = 'packages/core/src/spatial/Geohash.ts';
    const existing = '// a large pre-existing source file\n'.repeat(50);

    it('HOLDS on an existing file that was NOT edited this turn (the Geohash stall)', () => {
      // The exact failure: the source exists + is large from turn 1, but
      // the model only narrated. Legacy gate would have advanced; the
      // edit gate holds the step.
      const r = evaluateDeliverableGate({
        content: existing,
        spec: { file, sniff: 'nonempty', requireChange: true },
        writes: [{ name: 'readFile', path: file, success: true }],
      });
      expect(r.satisfied).toBe(false);
      expect(r.reason).toContain('requireChange');
    });

    it('ADVANCES once the model writes to the deliverable this turn', () => {
      const r = evaluateDeliverableGate({
        content: existing,
        spec: { file, sniff: 'nonempty', requireChange: true },
        writes: [{ name: 'replaceInFile', path: file, success: true }],
      });
      expect(r.satisfied).toBe(true);
      expect(r.reason).toContain('edited this turn');
    });

    it('still enforces the sniff/minBytes floor even after a write', () => {
      // Model wrote the file but truncated the script — must not advance.
      const r = evaluateDeliverableGate({
        content: '<html><script>function f(){',
        spec: { file: 'index.html', sniff: 'html-complete', requireChange: true },
        writes: [{ name: 'writeFile', path: 'index.html', success: true }],
      });
      expect(r.satisfied).toBe(false);
      expect(r.reason).toContain('html-complete');
    });
  });
});
