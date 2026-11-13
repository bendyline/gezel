import { describe, expect, it } from 'vitest';
import {
  DEGENERATE_STRIKE_WINDOW_MS,
  DegenerateRunDetector,
  DegenerateStrikes,
  DraftAcceptanceMonitor,
  buildDegenerateModelMessage,
  buildDegenerateUserMessage,
  describeDegenerateReport,
} from './degenerate-output.js';

function feed(detector: DegenerateRunDetector, text: string, chunk = 1) {
  for (let i = 0; i < text.length; i += chunk) {
    const run = detector.observe(text.slice(i, i + chunk));
    if (run) return run;
  }
  return null;
}

describe('DegenerateRunDetector', () => {
  it('fires on one character repeated, one token at a time (the 2026-11-10 shape)', () => {
    const d = new DegenerateRunDetector('reasoning', 1024);
    const prose = 'Checking which files the step needs next ';
    const run = feed(d, prose + '/'.repeat(5000));
    expect(run).toEqual({ channel: 'reasoning', unit: '/', length: 1024 });
  });

  it('does not fire before the run reaches the threshold', () => {
    const d = new DegenerateRunDetector('reasoning', 1024);
    expect(feed(d, 'x'.repeat(1023), 64)).toBeNull();
    expect(d.observe('x')).toEqual({ channel: 'reasoning', unit: 'x', length: 1024 });
  });

  it('fires on a short cycle and reports the smallest unit', () => {
    const d = new DegenerateRunDetector('content', 512);
    const run = feed(d, '</function>\n'.repeat(10) + 'ab'.repeat(400), 7);
    // The unit is read where the run stood when it fired, so either phase.
    expect(['ab', 'ba']).toContain(run?.unit);
    expect(run?.channel).toBe('content');
  });

  it('reports the whole run it can see, not just the threshold', () => {
    const d = new DegenerateRunDetector('content', 100);
    const run = d.observe('-'.repeat(150));
    expect(run?.length).toBe(150);
  });

  it('ignores cycles longer than the max period', () => {
    const d = new DegenerateRunDetector('content', 1024);
    expect(feed(d, 'planning '.repeat(300), 50)).toBeNull();
  });

  it('stays quiet on long varied prose, tables and code', () => {
    const d = new DegenerateRunDetector('reasoning', 256);
    const table = Array.from(
      { length: 40 },
      (_, i) => `| row ${i} | ${'—'.repeat(20)} | value ${i * 7} |\n`,
    ).join('');
    const code = Array.from({ length: 60 }, (_, i) => `const v${i} = compute(${i}, '/');\n`).join(
      '',
    );
    expect(feed(d, table + code + '='.repeat(80), 13)).toBeNull();
  });

  it('fires once', () => {
    const d = new DegenerateRunDetector('reasoning', 16);
    expect(d.observe('/'.repeat(16))).not.toBeNull();
    expect(d.observe('/'.repeat(16))).toBeNull();
  });
});

describe('DraftAcceptanceMonitor', () => {
  it('flags a collapse to ~0 on an engine that earlier drafted well (the 2026-11-10 numbers)', () => {
    const m = new DraftAcceptanceMonitor();
    expect(m.observe({ drafted: 7572, accepted: 6322 }, 48300)).toEqual({ sick: false });
    expect(m.observe({ drafted: 49143, accepted: 0 }, 48300)).toMatchObject({
      sick: true,
      acceptance: 0,
      drafted: 49143,
      accepted: 0,
    });
  });

  it('never condemns a drafter that was always poor', () => {
    const m = new DraftAcceptanceMonitor();
    expect(m.observe({ drafted: 4000, accepted: 300 }, 1)).toEqual({ sick: false });
    expect(m.observe({ drafted: 4000, accepted: 10 }, 1)).toEqual({ sick: false });
  });

  it('needs enough drafted tokens before judging', () => {
    const m = new DraftAcceptanceMonitor();
    m.observe({ drafted: 3000, accepted: 2400 }, 1);
    expect(m.observe({ drafted: 1999, accepted: 0 }, 1)).toEqual({ sick: false });
  });

  it('starts over when the engine process changes', () => {
    const m = new DraftAcceptanceMonitor();
    m.observe({ drafted: 3000, accepted: 2400 }, 1);
    expect(m.observe({ drafted: 5000, accepted: 0 }, 2)).toEqual({ sick: false });
  });

  it('a reset forgets the baseline', () => {
    const m = new DraftAcceptanceMonitor();
    m.observe({ drafted: 3000, accepted: 2400 }, 1);
    m.reset();
    expect(m.observe({ drafted: 5000, accepted: 0 }, 1)).toEqual({ sick: false });
  });
});

describe('degenerate output messages', () => {
  const repeated = {
    kind: 'repeated-output',
    channel: 'reasoning',
    unit: '/',
    length: 1024,
  } as const;

  it('describes repeated output for logs', () => {
    expect(describeDegenerateReport(repeated)).toBe('repeated "/" for 1024 chars of reasoning');
  });

  it('tells the person plainly what happened and what to do', () => {
    expect(buildDegenerateUserMessage(repeated, true)).toBe(
      'The on-device model got stuck repeating "/" and produced nothing usable. Gezel restarted it. Try again.',
    );
    expect(
      buildDegenerateUserMessage(
        { kind: 'draft-collapse', drafted: 49143, accepted: 0, baseline: 0.83 },
        false,
      ),
    ).toBe(
      'The on-device model started producing output that made no sense. Restart the on-device engine, then try again.',
    );
  });

  it('tells the model the fault is the engine, not its work', () => {
    const msg = buildDegenerateModelMessage('[llama-cpp]', repeated, true);
    expect(msg).toContain('[llama-cpp] stopped this turn');
    expect(msg).toContain('not in your work');
    expect(msg).toContain('restarted');
  });

  it('blames no engine for a first run the engine kept', () => {
    const msg = buildDegenerateModelMessage('[llama-cpp]', repeated, 'kept');
    expect(msg).toContain('without repeating yourself');
    expect(msg).not.toContain('fault in the engine');
    expect(buildDegenerateUserMessage(repeated, 'kept')).toBe(
      'The on-device model got stuck repeating "/", so Gezel stopped it. Try again.',
    );
  });
});

describe('DegenerateStrikes', () => {
  it('condemns an engine on its second run within the window', () => {
    const strikes = new DegenerateStrikes();
    expect(strikes.strike(1, 0)).toBe(false);
    expect(strikes.strike(1, DEGENERATE_STRIKE_WINDOW_MS)).toBe(true);
    // A condemned engine starts over.
    expect(strikes.strike(1, DEGENERATE_STRIKE_WINDOW_MS + 1)).toBe(false);
  });

  it('forgets a run outside the window, and a run on another process', () => {
    const strikes = new DegenerateStrikes();
    expect(strikes.strike(1, 0)).toBe(false);
    expect(strikes.strike(1, DEGENERATE_STRIKE_WINDOW_MS + 1)).toBe(false);
    expect(strikes.strike(2, DEGENERATE_STRIKE_WINDOW_MS + 2)).toBe(false);
    expect(strikes.strike(2, DEGENERATE_STRIKE_WINDOW_MS + 3)).toBe(true);
  });
});
