import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCommandApprovalAnswer } from './command-approval-answer.js';
import {
  hashCommandInvocation,
  lookupApproval,
  readCommandApprovals,
} from './command-approvals.js';

let home: string;
const projectId = 'proj-answer';

beforeEach(async () => {
  home = join(tmpdir(), `gezel-cmd-answer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(home, 'projects', projectId), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('applyCommandApprovalAnswer', () => {
  it('persists an approval for only the exact body and arguments shown', async () => {
    const body = 'C:\\workspace\\node_modules\\.bin\\vitest.cmd';
    const args = ['run', '--coverage'];
    const inputFiles = [{ path: 'node_modules/.bin/vitest.cmd', sha256: 'a'.repeat(64) }];
    await applyCommandApprovalAnswer({
      home,
      projectId,
      intent: {
        kind: 'command-approval',
        scope: 'npx',
        name: 'vitest',
        body,
        args,
        inputFiles,
      },
      answer: { selectedChoices: [0], declined: false, at: new Date().toISOString() },
    });

    const approvals = await readCommandApprovals(home, projectId);
    expect(
      lookupApproval(approvals, 'npx', 'vitest', hashCommandInvocation(body, args, inputFiles)),
    ).toBe('approved');
    expect(
      lookupApproval(
        approvals,
        'npx',
        'vitest',
        hashCommandInvocation(body, ['run', '&', 'echo', 'changed'], inputFiles),
      ),
    ).toBeUndefined();
    expect(
      lookupApproval(
        approvals,
        'npx',
        'vitest',
        hashCommandInvocation(body, args, [{ path: inputFiles[0]!.path, sha256: 'b'.repeat(64) }]),
      ),
    ).toBeUndefined();
  });
});
