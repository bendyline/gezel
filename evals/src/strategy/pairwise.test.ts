import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JudgeBundle } from './judge.ts';
import { judgePairwise, pairwisePrompt } from './pairwise.ts';

const bundle = (report: string): JudgeBundle => ({
  request: 'Write the report.',
  goal: 'A cited report.',
  bar: ['Cites its sources'],
  deliverables: [
    { label: 'Deliverable 1 (markdown): The report', text: report },
    { label: 'Deliverable 2 (json): The data', text: '{"rows": 6}' },
  ],
  sources: [{ label: 'source/brief.md', text: 'Growth was 21%.' }],
});

let dir: string;
let cli: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-pairwise-'));
  cli = join(dir, 'claude');
  // Prefers whichever version shows the text GOOD, as a judge reading the prompt would.
  await writeFile(
    cli,
    `#!/usr/bin/env node
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const a = prompt.indexOf('version A\\n\\nGOOD') >= 0;
const b = prompt.indexOf('version B\\n\\nGOOD') >= 0;
process.stdout.write(JSON.stringify({ structured_output: { better: a ? 'A' : b ? 'B' : 'tie', reasons: 'r' } }));
`,
  );
  await chmod(cli, 0o755);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('pairwise judge', () => {
  it('shows a deliverable both versions share once, and only the differing one twice', () => {
    const prompt = pairwisePrompt(bundle('old text'), bundle('new text'));
    expect(prompt.match(/\{"rows": 6\}/g)).toHaveLength(1);
    expect(prompt).toContain('Deliverable 1 (markdown): The report: version A\n\nold text');
    expect(prompt).toContain('Deliverable 1 (markdown): The report: version B\n\nnew text');
  });

  it('maps A and B back to before and after across alternating orders', () => {
    const better = judgePairwise(bundle('bad'), bundle('GOOD'), { cliPath: cli, samples: 4 });
    expect(better.errors).toEqual([]);
    expect(better.samples.map((s) => s.order)).toEqual([
      'before-first',
      'after-first',
      'before-first',
      'after-first',
    ]);
    expect(better.samples.every((s) => s.better === 'after')).toBe(true);
    expect(better.score).toBe(1);
    const worse = judgePairwise(bundle('GOOD'), bundle('bad'), { cliPath: cli, samples: 2 });
    expect(worse.score).toBe(-1);
  });
});
