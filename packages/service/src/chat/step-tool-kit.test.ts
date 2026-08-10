import { deliverableStep } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  capPriorityPrefixForKind,
  firstActionForKind,
  gateRepairToolsForKind,
  stepGateRepairActive,
  stepToolKit,
} from './step-tool-kit.js';

function expandedStep(path: string, kind: Parameters<typeof deliverableStep>[0]['kind']) {
  const { advanceWhen, gate } = deliverableStep({ selfId: 's', path, kind });
  return { ...(advanceWhen ? { advanceWhen } : {}), gate };
}

describe('stepToolKit', () => {
  it('a markdown-report step gets the file core and nothing execution-shaped', () => {
    const kit = stepToolKit(expandedStep('report.md', 'markdown-report'));
    expect(kit?.kind).toBe('markdown-doc');
    expect(kit?.path).toBe('report.md');
    expect(kit?.tools.has('read_file')).toBe(true);
    expect(kit?.tools.has('read_files')).toBe(true);
    expect(kit?.tools.has('write_file')).toBe(true);
    expect(kit?.tools.has('replace_in_file')).toBe(true);
    expect(kit?.tools.has('run_nodejs_script')).toBe(false);
    expect(kit?.tools.has('render_image')).toBe(false);
  });

  it('a data-file step carries the execution channel (derive_file + sandbox)', () => {
    const kit = stepToolKit(expandedStep('out/rows.csv', 'data-file'));
    expect(kit?.kind).toBe('data-file');
    expect(kit?.tools.has('derive_file')).toBe(true);
    expect(kit?.tools.has('run_nodejs_script')).toBe(true);
    expect(kit?.tools.has('make_dir')).toBe(true);
  });

  it('html steps add insert_at_marker; code steps add patch + sandbox', () => {
    expect(
      stepToolKit(expandedStep('index.html', 'html-game'))?.tools.has('insert_at_marker'),
    ).toBe(true);
    const code = stepToolKit(expandedStep('src/mod.ts', 'code-module'));
    expect(code?.tools.has('apply_patch')).toBe(true);
    expect(code?.tools.has('run_nodejs_script')).toBe(true);
  });

  it('gate-check-driven additions: grounding checks pull in search tools', () => {
    const kit = stepToolKit({
      advanceWhen: { file: 'brief.md' },
      gate: {
        at: 'completion',
        checks: [
          { kind: 'minBytes', file: 'brief.md', bytes: 100 },
          { kind: 'citationsResolve', file: 'brief.md' },
        ],
      },
    });
    expect(kit?.tools.has('grep_files')).toBe(true);
    expect(kit?.tools.has('find_files')).toBe(true);
  });

  it('a nodeRuns gate pulls in the sandbox even on a doc kind', () => {
    const kit = stepToolKit({
      advanceWhen: { file: 'notes.md' },
      gate: {
        at: 'completion',
        checks: [{ kind: 'nodeRuns', file: 'scripts/check.mjs' }],
      },
    });
    expect(kit?.tools.has('run_nodejs_script')).toBe(true);
  });

  it('artifact-targeted steps add the artifact drawer', () => {
    const kit = stepToolKit({
      advanceWhen: { file: 'reports/audit.md', artifact: true },
    });
    expect(kit?.tools.has('write_artifact')).toBe(true);
    expect(kit?.tools.has('read_artifact')).toBe(true);
    expect(kit?.tools.has('grep_artifact')).toBe(true);
  });

  it('workspace-targeted steps keep the drawer too — the writes-off escape hatch', () => {
    const kit = stepToolKit(expandedStep('notes/scan.md', 'markdown-notes'));
    expect(kit?.tools.has('write_artifact')).toBe(true);
    expect(kit?.tools.has('read_artifact')).toBe(true);
    expect(kit?.tools.has('list_artifacts')).toBe(true);
    expect(kit?.tools.has('grep_artifact')).toBe(true);
  });

  it('a step with no file signal has no kit', () => {
    expect(stepToolKit({})).toBeNull();
  });
});

describe('firstActionForKind', () => {
  it('data kinds derive; images render; docs write', () => {
    expect(firstActionForKind('data-file', 'out.csv')).toContain('derive_file');
    expect(firstActionForKind('image-set', 'assets/logo.png')).toContain('render_image');
    expect(firstActionForKind('markdown-doc', 'doc.md')).toContain('write_file');
  });
});

describe('gateRepairToolsForKind', () => {
  it('the data repair set carries the execution channel (the stranded-repair gap)', () => {
    const tools = gateRepairToolsForKind('data-file');
    expect(tools.has('derive_file')).toBe(true);
    expect(tools.has('run_nodejs_script')).toBe(true);
    expect(tools.has('replace_in_file')).toBe(true);
  });

  it('doc repairs stay file-core only', () => {
    const tools = gateRepairToolsForKind('markdown-doc');
    expect(tools.has('write_file')).toBe(true);
    expect(tools.has('derive_file')).toBe(false);
  });

  it('every repair set carries the drawer write channel', () => {
    expect(gateRepairToolsForKind('markdown-doc').has('write_artifact')).toBe(true);
    expect(gateRepairToolsForKind(null).has('write_artifact')).toBe(true);
  });
});

describe('stepGateRepairActive — clamp-lifetime derivation', () => {
  it('ad-hoc plateau present → active; cleared → inactive', () => {
    expect(stepGateRepairActive(undefined, { deliverableGatePlateau: { count: 1 } })).toBe(true);
    expect(stepGateRepairActive(undefined, {})).toBe(false);
  });

  it('craftbook step: gateAttempts / lastGateReject / gateAttemptHistory each activate', () => {
    expect(stepGateRepairActive({ gateAttempts: 1 }, {})).toBe(true);
    expect(stepGateRepairActive({ lastGateReject: { at: 'T' } }, {})).toBe(true);
    // gateAttemptHistory is the load-bearing one: bumpStepActivation
    // clears gateAttempts/lastGateReject on the onReject:self loop.
    expect(stepGateRepairActive({ gateAttemptHistory: [{}] }, {})).toBe(true);
    expect(stepGateRepairActive({}, {})).toBe(false);
  });

  it('a completed step never clamps (structural expiry)', () => {
    expect(stepGateRepairActive({ completedAt: '2026-07-07T00:00:00Z', gateAttempts: 3 }, {})).toBe(
      false,
    );
  });
});

describe('capPriorityPrefixForKind', () => {
  it('data steps rank derive_file first; no kind → no prefix', () => {
    expect(capPriorityPrefixForKind('data-file')[0]).toBe('derive_file');
    expect(capPriorityPrefixForKind(null)).toEqual([]);
  });

  it.each(['data-file', 'code-module', 'markdown-report'] as const)(
    'keeps read_files beside read_file in the %s cap prefix',
    (kind) => {
      const priority = capPriorityPrefixForKind(kind);
      expect(priority.indexOf('read_files')).toBe(priority.indexOf('read_file') + 1);
    },
  );
});
