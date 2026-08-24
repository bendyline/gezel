import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behavioral coverage for checkFixReview: the sdk is mocked with in-memory
 * workspace + artifacts trees and a task record; each run() re-imports the
 * real script so the whole input → verdict → routing path is exercised.
 */

const h = vi.hoisted(() => {
  const workspace = new Map<string, string>();
  const artifacts = new Map<string, string>();
  let task: Record<string, unknown> | null = null;
  let input: Record<string, unknown> = {};
  let output: unknown;
  let stamped = false;

  return {
    workspace,
    artifacts,
    setTask(next: Record<string, unknown> | null) {
      task = next;
    },
    begin(next: Record<string, unknown>) {
      input = next;
      output = undefined;
      stamped = false;
    },
    result(): unknown {
      if (!stamped) throw new Error('script finished without stamping an output');
      return output;
    },
    reset() {
      workspace.clear();
      artifacts.clear();
      task = null;
    },
    gezel: {
      get input() {
        return input;
      },
      output(value: unknown) {
        if (stamped) throw new Error('output stamped twice');
        stamped = true;
        output = value;
      },
      log() {},
      task: {
        async get() {
          if (!task) throw new Error('task not found');
          return task;
        },
      },
      fs: {
        async read(path: string): Promise<string> {
          const hit = workspace.get(path);
          if (hit === undefined) throw new Error(`file not found: ${path}`);
          return hit;
        },
      },
      artifacts: {
        async read(path: string): Promise<string> {
          const hit = artifacts.get(path);
          if (hit === undefined) throw new Error(`artifact not found: ${path}`);
          return hit;
        },
      },
    },
  };
});

vi.mock('@bendyline/gezel-sdk', () => ({
  defineScript: <T>(meta: T) => meta,
  gezel: h.gezel,
}));

vi.mock('@bendyline/gezel-sdk/checks', () => ({
  gateResult: (ok: boolean, detail: string) =>
    ok ? { decision: 'approve', message: detail } : { decision: 'reject', message: detail },
}));

interface Result {
  decision?: string;
  message?: string;
  goto?: string;
}

async function run(input: Record<string, unknown>): Promise<Result> {
  h.begin({ taskRef: 'default/7', ...input });
  vi.resetModules();
  await import('./checkFixReview.js');
  return h.result() as Result;
}

const REVIEW = 'tasks/7/review.md';

function reviewDoc(opts: { verdict: string; rows?: string[] }): string {
  const table =
    opts.rows && opts.rows.length > 0
      ? [
          '| Severity | File | Line | Problem | Fix |',
          '| --- | --- | --- | --- | --- |',
          ...opts.rows,
        ].join('\n')
      : '(no findings)';
  return `## Summary\n\nLooked at the fix.\n\n## Findings\n\n${table}\n\nVerdict: ${opts.verdict}\n`;
}

beforeEach(() => {
  h.reset();
  h.setTask({ num: 7, artifactDir: 'tasks/7' });
});

describe('checkFixReview', () => {
  it('rejects in place when the review has not been written', async () => {
    const res = await run({});
    expect(res.decision).toBe('reject');
    expect(res.goto).toBeUndefined();
    expect(res.message).toContain('tasks/7/review.md');
  });

  it('rejects a review with no verdict line', async () => {
    h.artifacts.set(REVIEW, '## Summary\n\nLooks fine to me.\n');
    const res = await run({});
    expect(res.decision).toBe('reject');
    expect(res.message).toMatch(/Verdict: PASS.*Verdict: REVISE/);
  });

  it('approves a well-formed PASS with real citations', async () => {
    h.workspace.set('src/cart.js', 'fixed');
    h.artifacts.set(
      REVIEW,
      reviewDoc({ verdict: 'PASS', rows: ['| minor | src/cart.js | 12 | style nit | rename |'] }),
    );
    const res = await run({});
    expect(res.decision).toBe('approve');
  });

  it('rejects fabricated citations, naming them', async () => {
    h.artifacts.set(
      REVIEW,
      reviewDoc({ verdict: 'PASS', rows: ['| minor | src/ghost.js | 1 | invented | n/a |'] }),
    );
    const res = await run({});
    expect(res.decision).toBe('reject');
    expect(res.message).toContain('src/ghost.js');
  });

  it('resolves citations through the diffpack overlay for a drafting task', async () => {
    h.setTask({ num: 7, artifactDir: 'tasks/7', diffpackId: '7' });
    h.artifacts.set('diffpacks/7/after/src/new-module.js', 'drafted content');
    h.artifacts.set(
      REVIEW,
      reviewDoc({
        verdict: 'PASS',
        rows: ['| minor | src/new-module.js | 3 | naming | rename |'],
      }),
    );
    const res = await run({});
    expect(res.decision).toBe('approve');
  });

  it('a PASS verdict with critical findings is inconsistent', async () => {
    h.workspace.set('src/auth.js', 'x');
    h.artifacts.set(
      REVIEW,
      reviewDoc({ verdict: 'PASS', rows: ['| critical | src/auth.js | 5 | bypass | fix |'] }),
    );
    const res = await run({});
    expect(res.decision).toBe('reject');
    expect(res.message).toMatch(/critical\/major.*REVISE/);
  });

  it('a well-formed REVISE rejects WITH goto to the fix step and the findings', async () => {
    h.workspace.set('src/auth.js', 'x');
    h.artifacts.set(
      REVIEW,
      reviewDoc({
        verdict: 'REVISE',
        rows: ['| major | src/auth.js | 5 | check bypassed | guard the branch |'],
      }),
    );
    const res = await run({});
    expect(res.decision).toBe('reject');
    expect(res.goto).toBe('fix');
    expect(res.message).toContain('src/auth.js');
    expect(res.message).toContain('guard the branch');
  });

  it('REVISE with an empty findings table is not actionable', async () => {
    h.artifacts.set(REVIEW, reviewDoc({ verdict: 'REVISE' }));
    const res = await run({});
    expect(res.decision).toBe('reject');
    expect(res.goto).toBeUndefined();
    expect(res.message).toMatch(/names nothing to fix/);
  });

  it('honors a custom fixStepId and reviewPath', async () => {
    h.workspace.set('lib/a.ts', 'x');
    h.artifacts.set(
      'tasks/7/qa/review.md',
      reviewDoc({ verdict: 'REVISE', rows: ['| minor | lib/a.ts | 1 | nit | tidy |'] }),
    );
    const res = await run({ reviewPath: 'tasks/7/qa/review.md', fixStepId: 'change' });
    expect(res.goto).toBe('change');
  });

  it('cross-checks the findings JSON row count when given', async () => {
    h.workspace.set('src/a.js', 'x');
    h.artifacts.set(
      REVIEW,
      reviewDoc({ verdict: 'PASS', rows: ['| minor | src/a.js | 1 | nit | tidy |'] }),
    );
    h.artifacts.set('tasks/7/review-findings.json', '[]');
    const res = await run({ findingsPath: 'tasks/7/review-findings.json' });
    expect(res.decision).toBe('reject');
    expect(res.message).toMatch(/0 finding\(s\).*table has 1/);
  });

  it('rejects bad severity vocabulary', async () => {
    h.workspace.set('src/a.js', 'x');
    h.artifacts.set(
      REVIEW,
      reviewDoc({ verdict: 'PASS', rows: ['| blocker | src/a.js | 1 | bad | fix |'] }),
    );
    const res = await run({});
    expect(res.decision).toBe('reject');
    expect(res.message).toContain('"blocker"');
  });
});
