import { describe, expect, it } from 'vitest';
import {
  type DeliverableWrite,
  deliverableWrittenThisTurn,
  evaluateDeliverableGate,
  hookOwnedAdvanceHasModelOutput,
  normalizeWorkspacePath,
} from './deliverable-gate.js';

const write = (over: Partial<DeliverableWrite> = {}): DeliverableWrite => ({
  name: 'write_file',
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
    expect(deliverableWrittenThisTurn([write({ name: 'replace_in_file', path: file })], file)).toBe(
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
    expect(deliverableWrittenThisTurn([write({ name: 'read_file', path: file })], file)).toBe(
      false,
    );
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

  it('accepts every workspace write tool name', () => {
    for (const name of [
      'write_file',
      'replace_in_file',
      'append_to_file',
      'apply_patch',
      'insert_at_marker',
    ]) {
      expect(deliverableWrittenThisTurn([write({ name, path: file })], file)).toBe(true);
    }
  });

  it('counts an artifact tool only when it reports a workspace redirect', () => {
    expect(
      deliverableWrittenThisTurn(
        [write({ name: 'write_artifact', path: file, resultText: `Wrote ${file}` })],
        file,
      ),
    ).toBe(false);
    expect(
      deliverableWrittenThisTurn(
        [
          write({
            name: 'write_artifact',
            path: file,
            resultText: `Wrote ${file} to the project workspace. Note: use write_file directly.`,
          }),
        ],
        file,
      ),
    ).toBe(true);
    expect(
      deliverableWrittenThisTurn(
        [
          write({
            name: 'write_artifact',
            path: file,
            resultText: `Wrote ${file} to the project workspace because this session expects it there.`,
          }),
        ],
        file,
      ),
    ).toBe(true);
  });
});

describe('hookOwnedAdvanceHasModelOutput', () => {
  it('holds a hook-owned file until the model writes the required task note', () => {
    expect(
      hookOwnedAdvanceHasModelOutput(true, true, [
        { name: 'read_artifact', path: 'tasks/98/pr-review/batches.json', success: true },
      ]),
    ).toBe(false);
    expect(
      hookOwnedAdvanceHasModelOutput(true, true, [{ name: 'write_task_note', success: true }]),
    ).toBe(true);
  });

  it('allows pure runtime steps and ordinary model-owned files', () => {
    expect(hookOwnedAdvanceHasModelOutput(true, false, [])).toBe(true);
    expect(hookOwnedAdvanceHasModelOutput(false, true, [])).toBe(true);
  });
});

describe('evaluateDeliverableGate', () => {
  it('recognizes a newly written artifact checkpoint without accepting a same-named workspace edit', () => {
    const spec = {
      file: 'tasks/7/report.json',
      artifact: true,
      requireChange: true,
      sniff: 'json-valid' as const,
    };
    const content = '{"complete":true}';
    const evaluate = (writes: DeliverableWrite[]) =>
      evaluateDeliverableGate({
        content,
        spec,
        writes: writes.map((w) => ({
          resultText:
            'Wrote tasks/7/report.json\nSaving an artifact does not complete the task step.',
          ...w,
        })),
      }).satisfied;
    expect(evaluate([write({ name: 'write_artifact', path: spec.file })])).toBe(true);
    expect(
      evaluate([write({ name: 'write_artifact', path: './artifacts/tasks\\7\\report.json' })]),
    ).toBe(true);
    expect(
      evaluate([
        write({ name: 'write_artifact', path: '/ARTIFACTS/artifacts/tasks/7/report.json' }),
      ]),
    ).toBe(true);
    expect(evaluate([write({ name: 'write_artifact', path: 'tasks/7/Report.json' })])).toBe(false);
    expect(evaluate([write({ name: 'write_file', path: spec.file })])).toBe(false);
    expect(evaluate([write({ name: 'read_artifact', path: spec.file })])).toBe(false);
    expect(evaluate([write({ name: 'write_artifact', path: spec.file, success: false })])).toBe(
      false,
    );
    expect(evaluate([])).toBe(false);
    expect(
      evaluate([write({ name: 'write_artifact', path: spec.file, resultText: undefined })]),
    ).toBe(false);
    expect(
      evaluate([
        write({
          name: 'write_artifact',
          path: spec.file,
          resultText: 'Wrote tasks/7/report.json to the project workspace.',
        }),
      ]),
    ).toBe(false);
    expect(
      evaluate([
        write({
          name: 'write_artifact',
          path: spec.file,
          resultText: 'Wrote different/report.json',
        }),
      ]),
    ).toBe(false);
  });

  it('does not confuse another task artifact, matching suffix, or artifact write with a workspace edit', () => {
    const call = write({
      name: 'write_artifact',
      path: 'tasks/8/report.json',
      resultText: 'Wrote tasks/8/report.json',
    });
    for (const file of ['tasks/7/report.json', 'report.json', 'workspace/tasks/8/report.json']) {
      expect(deliverableWrittenThisTurn([call], file, true)).toBe(false);
    }
    expect(deliverableWrittenThisTurn([call], call.path!)).toBe(false);
  });

  it('requires a complete artifact even when this turn wrote it', () => {
    const spec = {
      file: 'report.json',
      artifact: true,
      requireChange: true,
      sniff: 'json-valid' as const,
    };
    const writes = [
      write({ name: 'write_artifact', path: spec.file, resultText: 'Wrote report.json' }),
    ];
    expect(evaluateDeliverableGate({ content: '{"incomplete":', spec, writes }).satisfied).toBe(
      false,
    );
    expect(evaluateDeliverableGate({ content: null, spec, writes }).satisfied).toBe(false);
  });

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
        writes: [{ name: 'read_file', path: file, success: true }],
      });
      expect(r.satisfied).toBe(false);
      expect(r.reason).toContain('requireChange');
    });

    it('ADVANCES once the model writes to the deliverable this turn', () => {
      const r = evaluateDeliverableGate({
        content: existing,
        spec: { file, sniff: 'nonempty', requireChange: true },
        writes: [{ name: 'replace_in_file', path: file, success: true }],
      });
      expect(r.satisfied).toBe(true);
      expect(r.reason).toContain('edited this turn');
    });

    it('still enforces the sniff/minBytes floor even after a write', () => {
      // Model wrote the file but truncated the script — must not advance.
      const r = evaluateDeliverableGate({
        content: '<html><script>function f(){',
        spec: { file: 'index.html', sniff: 'html-complete', requireChange: true },
        writes: [{ name: 'write_file', path: 'index.html', success: true }],
      });
      expect(r.satisfied).toBe(false);
      expect(r.reason).toContain('html-complete');
    });
  });
});
