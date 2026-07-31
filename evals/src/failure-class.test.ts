import { describe, expect, it } from 'vitest';
import { classifyTrial, summarizeNativeEngineIncidents } from './failure-class.ts';

describe('classifyTrial — terminal classes', () => {
  it('success → pass', () => {
    expect(classifyTrial({ success: true }).failureClass).toBe('pass');
  });

  it('operator interrupt via failureMode', () => {
    const c = classifyTrial({ success: false, failureMode: 'interrupted', reason: 'whatever' });
    expect(c).toMatchObject({ failureClass: 'operator', rule: 'operator-interrupt' });
  });

  it('operator interrupt via legacy reason string', () => {
    const c = classifyTrial({
      success: false,
      reason: 'interrupted (SIGINT/SIGTERM); cleanup ran',
    });
    expect(c.failureClass).toBe('operator');
  });

  it('capacity denial in the reason', () => {
    const c = classifyTrial({
      success: false,
      reason:
        'capacity broker denied llama-cpp:nemotron3-super-120b:0: budget exhausted: would commit 103261295501 against 78357907046',
    });
    expect(c).toMatchObject({ failureClass: 'infra', rule: 'capacity-denial' });
  });

  it('capacity denial hidden behind a stall reason but present in the log', () => {
    // The nemotron-super class: turn threw at t+25ms, trial then
    // sat to soft-timeout and was recorded as "engine appears hung".
    const c = classifyTrial({
      success: false,
      failureMode: 'chat-stalled',
      reason: 'chat stalled for 302s — daemon reachable but issuing no model turns',
      daemonLog:
        '2026-05-24T14:17:01Z ERROR capacity broker denied llama-cpp:nemotron3-super-120b:0: budget exhausted: would commit 103261295501 against 78357907046\n',
    });
    expect(c).toMatchObject({ failureClass: 'infra', rule: 'capacity-denial' });
  });

  it('context overflow', () => {
    const c = classifyTrial({
      success: false,
      reason: 'context overflow: 25,154 tokens needed but only 24,576 available',
    });
    expect(c).toMatchObject({ failureClass: 'infra', rule: 'context-overflow' });
  });

  it('engine-hung failureMode and wedged-render reason', () => {
    expect(
      classifyTrial({ success: false, failureMode: 'engine-hung', reason: 'x' }).failureClass,
    ).toBe('infra');
    expect(
      classifyTrial({
        success: false,
        reason: 'image render wedged: generate_image started but sd-server produced no output',
      }).rule,
    ).toBe('engine-hung');
  });

  it('plain retry-loop failure stays model', () => {
    const c = classifyTrial({
      success: false,
      failureMode: 'model-stuck',
      reason: 'retry loop (fast-path): sniff "tic-tac-toe:4:2" stuck for 8m — 5 re-writes',
    });
    expect(c).toMatchObject({ failureClass: 'model', rule: 'model-default' });
  });
});

describe('classifyTrial — log-signature rules (stall-gated)', () => {
  const stall = {
    success: false,
    failureMode: 'chat-stalled',
    reason: 'chat stalled for 302s — daemon reachable but issuing no model turns',
  };

  it('unclosed render at kill time → infra render-killed', () => {
    const log = [
      '2026-06-01T03:02:29Z INFO [native] [sd-server] [INFO ] stable-diffusion.cpp:3395 - generate_image 512x512',
      '2026-06-01T03:05:00Z INFO [native] [sd-server]   |====>     | 8/20 - 35.0s/it',
    ].join('\n');
    const c = classifyTrial({ ...stall, daemonLog: log });
    expect(c).toMatchObject({ failureClass: 'infra', rule: 'render-killed' });
  });

  it('a completed render does NOT trigger render-killed', () => {
    const log = [
      '... stable-diffusion.cpp:3395 - generate_image 512x512',
      '... stable-diffusion.cpp:3615 - generate_image completed in 220.61s',
    ]
      .map((l) => `2026-06-01T03:02:29Z INFO [native] [sd-server] [INFO ] ${l}`)
      .join('\n');
    const c = classifyTrial({ ...stall, daemonLog: log });
    expect(c.rule).toBe('model-default');
  });

  it('repeated Jinja role-alternation 500s → infra chat-template-500', () => {
    const line =
      'ERROR Jinja Exception: Conversation roles must alternate user/assistant/user/assistant/...';
    const c = classifyTrial({ ...stall, daemonLog: Array(4).fill(line).join('\n') });
    expect(c).toMatchObject({ failureClass: 'infra', rule: 'chat-template-500' });
  });

  it('CUDA invalid-argument + llama SIGABRT → infra cuda-engine-crash', () => {
    const c = classifyTrial({
      ...stall,
      daemonLog: [
        '[chat] [llama-server] CUDA error: invalid argument',
        '[chat] [llama-server] current device: 0, in function ggml_cuda_kernel_launch',
        '[chat] [llama-server] exited (code=null signal=SIGABRT)',
      ].join('\n'),
    });
    expect(c).toMatchObject({ failureClass: 'infra', rule: 'cuda-engine-crash' });
  });

  it('structured native incident attributes a stall even if daemon tail rolled over', () => {
    const nativeIncidentLog = JSON.stringify({
      incidentId: 'native-55121-1234',
      expected: false,
      signal: 'SIGABRT',
      panicKind: 'cuda-invalid-argument',
      panicLine: '[llama-server] CUDA error: invalid argument',
    });
    const c = classifyTrial({ ...stall, daemonLog: 'later unrelated output', nativeIncidentLog });
    expect(c).toMatchObject({ failureClass: 'infra', rule: 'cuda-engine-crash' });
  });

  it('structured CUDA incident takes precedence over a generic runner crash', () => {
    const c = classifyTrial({
      success: false,
      failureMode: 'crash',
      reason: 'runner crashed: fetch failed',
      nativeIncidentLog: JSON.stringify({
        incidentId: 'native-55121-1234',
        expected: false,
        signal: 'SIGABRT',
        panicKind: 'cuda-invalid-argument',
      }),
    });
    expect(c).toMatchObject({ failureClass: 'infra', rule: 'cuda-engine-crash' });
  });

  it('a generic runner crash without a native signature stays daemon-crash', () => {
    const c = classifyTrial({
      success: false,
      failureMode: 'crash',
      reason: 'runner crashed: service connection closed',
    });
    expect(c).toMatchObject({ failureClass: 'infra', rule: 'daemon-crash' });
  });

  it('an isolated CUDA error without a child abort is not enough to re-blame the trial', () => {
    const c = classifyTrial({
      ...stall,
      daemonLog: '[chat] [llama-server] CUDA error: invalid argument\nengine recovered',
    });
    expect(c).toMatchObject({ failureClass: 'model', rule: 'model-default' });
  });

  it('one Jinja 500 is recoverable — stays model', () => {
    const c = classifyTrial({
      ...stall,
      daemonLog: 'ERROR Jinja Exception: Conversation roles must alternate user/assistant',
    });
    expect(c.failureClass).toBe('model');
  });

  it('voorman-is-meester scheduler deadlock → infra', () => {
    const line = '[tasks] [scheduler] tank-combat-arcade: skip — voorman is the Meester';
    const c = classifyTrial({ ...stall, daemonLog: Array(56).fill(line).join('\n') });
    expect(c).toMatchObject({ failureClass: 'infra', rule: 'scheduler-voorman-deadlock' });
  });

  it('log signatures do NOT apply to non-stall failures', () => {
    // A success-check-false trial with an incidental old render-start in
    // the log must not be re-blamed on infra.
    const c = classifyTrial({
      success: false,
      failureMode: 'success-check-false',
      reason: 'deliverable failed the success check',
      daemonLog: '[native] [sd-server] [INFO ] stable-diffusion.cpp:3395 - generate_image 512x512',
    });
    expect(c.failureClass).toBe('model');
  });
});

describe('summarizeNativeEngineIncidents', () => {
  it('retains recovered crash counts and ignores expected exits', () => {
    const summary = summarizeNativeEngineIncidents(
      [
        JSON.stringify({
          incidentId: 'native-1-100',
          expected: false,
          signal: 'SIGABRT',
          panicKind: 'cuda-invalid-argument',
          panicLine: 'CUDA error: invalid argument',
        }),
        JSON.stringify({ incidentId: 'native-2-200', expected: true, signal: 'SIGTERM' }),
        'partial-json',
      ].join('\n'),
    );
    expect(summary).toEqual({
      count: 1,
      kinds: { 'cuda-invalid-argument': 1 },
      incidentIds: ['native-1-100'],
      evidence: ['CUDA error: invalid argument'],
    });
  });
});
