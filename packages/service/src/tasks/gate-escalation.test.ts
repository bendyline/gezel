import type { GateAttemptRecord } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isGateSurgicalEditTurn,
  isImmediateFileWriteTurn,
  isScenarioFileRepairTurn,
} from '../providers/llama-cpp/provider.js';
import {
  GATE_ATTEMPT_TRAIL_CAP,
  appendGateAttempt,
  buildPlateauDiagnosisNote,
  buildStageOneNudge,
  buildStageTwoNudge,
  escalationDisabled,
  gateFailureSignature,
  plateauScore,
  stageForPlateau,
} from './gate-escalation.js';
import type { GateCheckOutcome } from './gate-eval.js';

const outcome = (label: string, ok: boolean, detail = 'detail text'): GateCheckOutcome => ({
  kind: 'contains',
  label,
  ok,
  detail,
});

const trailEntry = (signatureHash: string, attempt = 1): GateAttemptRecord => ({
  at: '2026-07-06T12:00:00.000Z',
  attempt,
  signatureHash,
  messageFingerprint: 'fp',
});

const WRITE_FILE_TOOL = [
  {
    type: 'function' as const,
    function: { name: 'write_file', description: 'Write a file.', parameters: {} },
  },
];

describe('gateFailureSignature', () => {
  it('is stable across detail-prose drift and check order', () => {
    const a = gateFailureSignature(
      [
        outcome('contains report.md /Total/', false, 'missing — 100 bytes'),
        outcome('minBytes report.md', false),
      ],
      [],
    );
    const b = gateFailureSignature(
      [
        outcome('minBytes report.md', false, 'is 4012 bytes, need 5000'),
        outcome('contains report.md /Total/', false, 'missing — 240 bytes'),
      ],
      [],
    );
    expect(a).toBe(b);
  });

  it('changes when a check clears and covers script rejects', () => {
    const both = gateFailureSignature(
      [outcome('contains report.md /Total/', false), outcome('minBytes report.md', false)],
      [],
    );
    const one = gateFailureSignature([outcome('contains report.md /Total/', false)], []);
    expect(both).not.toBe(one);
    const script = gateFailureSignature(undefined, [
      { scriptName: 'checkTone', decision: 'reject' },
    ]);
    expect(script).not.toBe(one);
    expect(script).toBe(
      gateFailureSignature([], [{ scriptName: 'checkTone', decision: 'reject' }]),
    );
  });

  it('ignores passing checks', () => {
    const withPass = gateFailureSignature(
      [outcome('minBytes report.md', true), outcome('contains report.md /Total/', false)],
      [],
    );
    const withoutPass = gateFailureSignature([outcome('contains report.md /Total/', false)], []);
    expect(withPass).toBe(withoutPass);
  });
});

describe('plateauScore + stageForPlateau', () => {
  it('counts the trailing run including the current attempt', () => {
    expect(plateauScore(undefined, 'sig-a')).toBe(1);
    expect(plateauScore([trailEntry('sig-a')], 'sig-a')).toBe(2);
    expect(plateauScore([trailEntry('sig-b'), trailEntry('sig-a')], 'sig-a')).toBe(2);
    expect(plateauScore([trailEntry('sig-a'), trailEntry('sig-a')], 'sig-a')).toBe(3);
    // A signature change mid-trail breaks the run.
    expect(plateauScore([trailEntry('sig-a'), trailEntry('sig-b')], 'sig-a')).toBe(1);
  });

  it('maps scores to stages', () => {
    expect(stageForPlateau(1)).toBe(0);
    expect(stageForPlateau(2)).toBe(1);
    expect(stageForPlateau(3)).toBe(2);
    expect(stageForPlateau(4)).toBe(3);
    expect(stageForPlateau(7)).toBe(3);
  });
});

describe('appendGateAttempt', () => {
  it('caps the trail at the rolling window', () => {
    let trail: GateAttemptRecord[] = [];
    for (let i = 1; i <= GATE_ATTEMPT_TRAIL_CAP + 3; i++) {
      trail = appendGateAttempt(trail, trailEntry('sig', i));
    }
    expect(trail).toHaveLength(GATE_ATTEMPT_TRAIL_CAP);
    expect(trail[0]?.attempt).toBe(4);
    expect(trail.at(-1)?.attempt).toBe(GATE_ATTEMPT_TRAIL_CAP + 3);
  });
});

describe('escalation nudges vs llama-cpp turn-mode matchers', () => {
  const bullets = '- index.html failed the html-game check: no render surface';

  it('stage 2 TRIPS immediate-write mode; stage 1 does NOT', () => {
    const stage2 = buildStageTwoNudge({ file: 'index.html', failingBullets: bullets, repeats: 3 });
    expect(isImmediateFileWriteTurn(stage2, WRITE_FILE_TOOL)).toBe(true);

    const stage1Frozen = buildStageOneNudge({
      file: 'index.html',
      failingBullets: bullets,
      frozen: true,
    });
    const stage1Churn = buildStageOneNudge({
      file: 'index.html',
      failingBullets: bullets,
      frozen: false,
    });
    expect(isImmediateFileWriteTurn(stage1Frozen, WRITE_FILE_TOOL)).toBe(false);
    expect(isImmediateFileWriteTurn(stage1Churn, WRITE_FILE_TOOL)).toBe(false);
  });

  it('neither stage matches the scenario-repair prompt matcher', () => {
    const stage1 = buildStageOneNudge({
      file: 'index.html',
      failingBullets: bullets,
      frozen: true,
    });
    const stage2 = buildStageTwoNudge({ file: 'index.html', failingBullets: bullets, repeats: 3 });
    const repairTools = [
      ...WRITE_FILE_TOOL,
      {
        type: 'function' as const,
        function: { name: 'replace_in_file', description: 'Edit.', parameters: {} },
      },
    ];
    expect(isScenarioFileRepairTurn(stage1, repairTools)).toBe(false);
    expect(isScenarioFileRepairTurn(stage2, repairTools)).toBe(false);
  });

  it('stage texts carry the marker, the file, and the bullets', () => {
    const stage2 = buildStageTwoNudge({ file: 'app.js', failingBullets: bullets, repeats: 3 });
    expect(stage2).toContain('GATE_FULL_REWRITE');
    expect(stage2).toContain('app.js');
    expect(stage2).toContain(bullets);
    const stage1 = buildStageOneNudge({ file: 'app.js', failingBullets: bullets, frozen: true });
    expect(stage1).toContain('GATE_TARGETED_EDIT:');
    expect(stage1).toContain('resubmitting unchanged content cannot pass');
    expect(stage1).toContain(bullets);
  });

  it('stage 1 TRIPS the gate-surgical-edit mode; stage 2 does NOT', () => {
    const patchTools = [
      {
        type: 'function' as const,
        function: { name: 'replace_in_file', description: 'Edit.', parameters: {} },
      },
      {
        type: 'function' as const,
        function: { name: 'replace_lines', description: 'Edit lines.', parameters: {} },
      },
      ...WRITE_FILE_TOOL,
    ];
    const stage1Frozen = buildStageOneNudge({
      file: 'index.html',
      failingBullets: bullets,
      frozen: true,
    });
    const stage1Churn = buildStageOneNudge({
      file: 'index.html',
      failingBullets: bullets,
      frozen: false,
    });
    expect(isGateSurgicalEditTurn(stage1Frozen, patchTools)).toBe(true);
    expect(isGateSurgicalEditTurn(stage1Churn, patchTools)).toBe(true);
    // No patch tool on the surface → the mode stays off (prompt-only steer).
    expect(isGateSurgicalEditTurn(stage1Frozen, WRITE_FILE_TOOL)).toBe(false);

    const stage2 = buildStageTwoNudge({ file: 'index.html', failingBullets: bullets, repeats: 3 });
    expect(isGateSurgicalEditTurn(stage2, patchTools)).toBe(false);

    // A scenario-check-shaped prompt containing the marker loses to
    // scenario-repair — the structural exclusion, not chain order.
    const scenarioShaped = `[scenario check] I looked at \`index.html\` and the success criteria aren't met yet.\n${stage1Frozen}`;
    expect(isGateSurgicalEditTurn(scenarioShaped, patchTools)).toBe(false);
  });
});

describe('buildPlateauDiagnosisNote', () => {
  it('lists the trail with frozen markers and the last verdict', () => {
    const note = buildPlateauDiagnosisNote({
      stepName: 'Build',
      stepId: 'step-build',
      trail: [
        { ...trailEntry('s', 1), failedChecks: ['contains report.md /Total/'] },
        { ...trailEntry('s', 2), frozen: true, failedChecks: ['contains report.md /Total/'] },
      ],
      lastMessage: '- report.md is missing required content /Total/',
    });
    expect(note).toContain('# Gate plateau — paused for help');
    expect(note).toContain('attempt 1');
    expect(note).toContain('content unchanged (frozen resubmit)');
    expect(note).toContain('- report.md is missing required content /Total/');
    expect(note).toContain('set the task active again');
  });
});

describe('escalationDisabled', () => {
  afterEach(() => {
    delete process.env.GEZEL_DISABLE_GATE_ESCALATION;
  });
  it('reads the kill-switch env', () => {
    expect(escalationDisabled()).toBe(false);
    process.env.GEZEL_DISABLE_GATE_ESCALATION = '1';
    expect(escalationDisabled()).toBe(true);
  });
});
