import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const files = new Map<string, string>();
  let output: unknown;
  return {
    files,
    get output() {
      return output;
    },
    reset() {
      output = undefined;
    },
    gezel: {
      input: {
        batchesFile: 'tasks/1/pr-review/batches.json',
        shardDir: 'tasks/1/pr-review',
        outFile: 'tasks/1/pr-review/synthesis-data.json',
      },
      output(value: unknown) {
        output = value;
      },
      artifacts: {
        async read(path: string) {
          const result = files.get(path);
          if (result === undefined) throw new Error(`missing ${path}`);
          return result;
        },
        async write(path: string, content: string) {
          files.set(path, content);
        },
      },
    },
  };
});
vi.mock('@bendyline/gezel-sdk', () => ({ defineScript: <T>(meta: T) => meta, gezel: h.gezel }));
const emptyVerification = `
## Verification candidates

\`\`\`json
{"verificationCandidates":[]}
\`\`\`
`;
beforeEach(() => {
  h.files.clear();
  h.reset();
  h.files.set(
    'tasks/1/pr-review/batches.json',
    JSON.stringify([
      { batchNumber: 1, start: 1, end: 2, paths: ['src/a.ts', 'src/b.ts'] },
      { batchNumber: 2, start: 3, end: 3, paths: ['src/c.ts'] },
    ]),
  );
  h.files.set(
    'tasks/1/pr-review/observations-1.md',
    `# Batch 1\n## src/a.ts\nVerified OK.\n## src/b.ts\n### Findings\n**B1-1** src/b.ts:4 — **Severity: major** — authorization bypass\n- Mechanism: unlike B9-2, the owner check is skipped.\n- Fix: compare owner.\n${'padding not copied\n'.repeat(1000)}${emptyVerification}`,
  );
  h.files.set(
    'tasks/1/pr-review/observations-2.md',
    `## Batch 2\n### \`src/c.ts\`\n### Findings\n### B2-1 — Minor: no issue\n- Fix: None needed.\n\n### B2-2 — severity **major** — Needs central verification\n- No evidence of the dependency is available in this batch.\n${emptyVerification}`,
  );
});

describe('summarizePullRequestObservations', () => {
  it('indexes every exact shard and keeps long prose out of synthesis context', async () => {
    vi.resetModules();
    await import('./summarizePullRequestObservations');
    expect(h.output).toMatchObject({ ok: true, batches: 2, candidates: 3 });
    const raw = h.files.get('tasks/1/pr-review/synthesis-data.json')!;
    const index = JSON.parse(raw);
    expect(index).toMatchObject({
      batchCount: 2,
      candidateCount: 3,
      actionableCandidateCount: 1,
      nonActionableCandidateCount: 2,
      shortlistLimit: 8,
      verificationCandidates: [],
    });
    expect(index.shortlist[0]).toMatchObject({
      id: 'B1-1',
      severity: 'major',
      likelyNonIssue: false,
    });
    expect(index.batches[1]).toMatchObject({
      candidateIds: ['B2-1', 'B2-2'],
      nonActionableIds: ['B2-1', 'B2-2'],
    });
    expect(index.shortlist).toHaveLength(1);
    expect(index.shortlist[0].preview).toContain('unlike B9-2, the owner check is skipped');
    expect(raw.length).toBeLessThan(2500);
  });
  it('carries structured cross-file candidates into synthesis data', async () => {
    h.files.set(
      'tasks/1/pr-review/observations-2.md',
      `## Batch 2
### \`src/c.ts\`
Needs central verification at the new-side line 29.

## Verification candidates

\`\`\`json
{"verificationCandidates":[{"id":"V2-1","path":"src/c.ts","line":29,"severity":"major","claim":"The route may call a helper that omits ownership enforcement.","verify":"Inspect packages/service/src/auth/owner.ts and the route registration."}]}
\`\`\`
`,
    );
    vi.resetModules();
    await import('./summarizePullRequestObservations');
    expect(h.output).toMatchObject({ verificationCandidates: 1 });
    const index = JSON.parse(h.files.get('tasks/1/pr-review/synthesis-data.json')!);
    expect(index.schemaVersion).toBe(2);
    expect(index.verificationCandidates).toEqual([
      expect.objectContaining({
        id: 'V2-1',
        path: 'src/c.ts',
        line: 29,
        severity: 'major',
        batchNumber: 2,
        observationsFile: 'tasks/1/pr-review/observations-2.md',
      }),
    ]);
    expect(index.batches[1].verificationCandidateIds).toEqual(['V2-1']);
  });
  it('keeps pre-channel in-flight shards compatible by treating absence as empty', async () => {
    for (const path of [
      'tasks/1/pr-review/observations-1.md',
      'tasks/1/pr-review/observations-2.md',
    ]) {
      h.files.set(path, h.files.get(path)!.replace(emptyVerification, ''));
    }
    vi.resetModules();
    await import('./summarizePullRequestObservations');
    const index = JSON.parse(h.files.get('tasks/1/pr-review/synthesis-data.json')!);
    expect(index.verificationCandidates).toEqual([]);
  });
  it('fails closed if a shard is missing or omits an assigned path', async () => {
    h.files.delete('tasks/1/pr-review/observations-2.md');
    vi.resetModules();
    await expect(import('./summarizePullRequestObservations')).rejects.toThrow(
      /Missing exact observations shard/,
    );
    expect(h.files.has('tasks/1/pr-review/synthesis-data.json')).toBe(false);
    h.files.set(
      'tasks/1/pr-review/observations-2.md',
      `## Batch 2\n### src/not-c.ts\n${emptyVerification}`,
    );
    vi.resetModules();
    await expect(import('./summarizePullRequestObservations')).rejects.toThrow(
      /lacks path heading/,
    );
  });
  it('drops speculative candidates and prioritizes product source over eval-only findings', async () => {
    h.files.set(
      'tasks/1/pr-review/observations-1.md',
      `# Batch 1\n## src/a.ts\nVerified OK.\n## src/b.ts\n### Findings\n**B1-1** \`evals/src/runner.ts:40\` — **major** — the loop performs one redundant probe on every run.\n**B1-2** \`packages/service/src/chat/manager.ts:90\` — **major** — the guard drops the only queued response when the owner disconnects.\n**B1-3** \`packages/core/src/state.ts:12\` — **critical** — this could lose state if a future provider changes its ordering.\n${emptyVerification}`,
    );
    h.files.set(
      'tasks/1/pr-review/observations-2.md',
      `## Batch 2\n### \`src/c.ts\`\nVerified OK.\n${emptyVerification}`,
    );
    vi.resetModules();
    await import('./summarizePullRequestObservations');
    const index = JSON.parse(h.files.get('tasks/1/pr-review/synthesis-data.json')!);
    expect(index.shortlist.map((candidate: { id: string }) => candidate.id)).toEqual([
      'B1-2',
      'B1-1',
    ]);
    expect(index.nonActionableCandidateCount).toBe(1);
  });
});
