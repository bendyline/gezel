import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EvalContext } from '../types.ts';
import {
  DOCS_PATH,
  FICTIONAL_SDK_KICKOFF_MESSAGE,
  FICTIONAL_SDK_MISSION_OBJECTIVES,
  FICTIONAL_SDK_SIGNALS,
  LIB_PATH,
  NON_SPAM_COUNT,
  QUILL_DOCS_MD,
  QUILL_LIB_MJS,
  QUILL_RUN_MJS,
  RUN_PATH,
  SPAM_COUNT,
  WORKER_PATH,
  fictionalSdkScenario,
  verifyQuillDir,
} from './fictional-sdk.ts';
import { TRUSTED_CHECK_RUNNER_ENV } from './trusted-check-runner.ts';

/**
 * Unwinnable-grader guard: (a) the seeded state and memorized-idiom
 * workers must FAIL the gate with the stub's instructive errors relayed
 * verbatim, and (b) a REFERENCE worker written strictly against
 * docs/quill-sdk.md must PASS — executed through the real run.mjs
 * driver via spawn, exactly as the production grader does.
 */

/** The docs-faithful reference solution. */
const REFERENCE_WORKER_MJS = `export async function worker(client) {
  for (;;) {
    const batch = client.take(5);
    if (batch.length === 0) break;
    for (const message of batch) {
      if (/spam/i.test(message.body)) {
        client.release(message.id);
      } else {
        client.commit(message.ackToken);
      }
    }
  }
  client.close();
}
`;

/** The ack(msg.id) muscle-memory trap: commits by id instead of ackToken. */
const MEMORIZED_IDIOM_WORKER_MJS = REFERENCE_WORKER_MJS.replace(
  'client.commit(message.ackToken)',
  'client.commit(message.id)',
);

/** Correct filing, but never calls close(). */
const NEVER_CLOSES_WORKER_MJS = REFERENCE_WORKER_MJS.replace('  client.close();\n', '');

/** Ignores the batches-of-5 rule. */
const WRONG_BATCH_WORKER_MJS = REFERENCE_WORKER_MJS.replace('client.take(5)', 'client.take(3)');

async function writeFileAt(dir: string, rel: string, content: string): Promise<void> {
  const target = join(dir, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function writeSeedWorkspace(dir: string): Promise<void> {
  await writeFileAt(dir, DOCS_PATH, QUILL_DOCS_MD);
  await writeFileAt(dir, LIB_PATH, QUILL_LIB_MJS);
  await writeFileAt(dir, RUN_PATH, QUILL_RUN_MJS);
}

describe('fictional-sdk grader — run.mjs gate against the instrumented stub', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(`${tmpdir()}/fictional-sdk-test-`);
    await writeSeedWorkspace(tmp);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('the seeded state (no worker.mjs) fails with worker-present missing', async () => {
    const result = await verifyQuillDir(tmp);
    expect(result.ok).toBe(false);
    expect(result.signals).toEqual(['docs-untouched', 'lib-untouched', 'run-untouched']);
    expect(result.missingRequiredSignals).toEqual(['worker-present']);
    expect(result.failReason).toContain(WORKER_PATH);
  });

  it('the REFERENCE worker passes every gate', async () => {
    await writeFileAt(tmp, WORKER_PATH, REFERENCE_WORKER_MJS);
    const result = await verifyQuillDir(tmp);
    expect(result.failReason).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.signals).toEqual([...FICTIONAL_SDK_SIGNALS]);
  }, 60_000);

  it('the memorized-idiom worker (commit by id) fails with the instructive stub error verbatim', async () => {
    await writeFileAt(tmp, WORKER_PATH, MEMORIZED_IDIOM_WORKER_MJS);
    const result = await verifyQuillDir(tmp);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['run-green']);
    expect(result.failReason).toContain(
      'commit() expects the ackToken from take(), not the message id',
    );
    expect(result.caseFailures?.some((l) => l.startsWith('CASE 2:'))).toBe(true);
  }, 60_000);

  it('a worker that never calls close() fails CASE 7', async () => {
    await writeFileAt(tmp, WORKER_PATH, NEVER_CLOSES_WORKER_MJS);
    const result = await verifyQuillDir(tmp);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['run-green']);
    expect(
      result.caseFailures?.some((l) => /^CASE 7: client\.close\(\) was never called/.test(l)),
    ).toBe(true);
  }, 60_000);

  it('a worker that ignores the batches-of-5 rule fails CASE 8 with the sizes it used', async () => {
    await writeFileAt(tmp, WORKER_PATH, WRONG_BATCH_WORKER_MJS);
    const result = await verifyQuillDir(tmp);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['run-green']);
    expect(result.caseFailures?.some((l) => l.startsWith('CASE 8:') && l.includes('3'))).toBe(true);
    await rm(join(tmp, WORKER_PATH));
  }, 60_000);

  it('tampering with lib/quill.mjs fails the byte-identical guard', async () => {
    await writeFileAt(tmp, LIB_PATH, QUILL_LIB_MJS.replace('qtok-', 'token-'));
    const result = await verifyQuillDir(tmp);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['lib-untouched']);
    expect(result.failReason).toContain(LIB_PATH);
    await writeFileAt(tmp, LIB_PATH, QUILL_LIB_MJS);
  });
});

describe('fictional-sdk — seed consistency & prompt evidence', () => {
  it('the seeded queue has exactly the documented spam/non-spam split', () => {
    const bodies = [...QUILL_LIB_MJS.matchAll(/\{ id: 'm-\d+', body: '([^']*)' \}/g)].map(
      (m) => m[1] ?? '',
    );
    expect(bodies).toHaveLength(SPAM_COUNT + NON_SPAM_COUNT);
    expect(bodies.filter((b) => /spam/i.test(b))).toHaveLength(SPAM_COUNT);
    expect(bodies.filter((b) => !/spam/i.test(b))).toHaveLength(NON_SPAM_COUNT);
  });

  // The de-facto prompt for seeded scenarios is the kickoff + mission
  // text. Every gated rule is stated there.
  const evidence =
    `${FICTIONAL_SDK_KICKOFF_MESSAGE}\n${FICTIONAL_SDK_MISSION_OBJECTIVES}`.toLowerCase();

  it.each([
    ['worker-present / export shape', /export async function worker\(client\)/],
    ['batches of 5', /client\.take\(5\)/],
    ['release spam by id', /client\.release\(message\.id\)/],
    ['commit via ackToken', /client\.commit\(message\.acktoken\)/],
    ['stop on empty take', /returns an empty array/],
    ['close at the end', /client\.close\(\)/],
    ['read the docs', /docs\/quill-sdk\.md/],
    ['guards', /do not modify docs\/quill-sdk\.md, lib\/quill\.mjs, or run\.mjs/],
  ])('required rule "%s" is stated in the kickoff/mission text', (_name, pattern) => {
    expect(pattern.test(evidence)).toBe(true);
  });
});

describe('fictional-sdk - trusted checker treatment', () => {
  it('pins the seeded runtime driver as the turn-boundary gate', async () => {
    vi.stubEnv(TRUSTED_CHECK_RUNNER_ENV, '1');
    try {
      const client = {
        listProjects: vi.fn().mockResolvedValue({
          projects: [{ id: 'quill-project', name: 'Quill Queue Worker' }],
        }),
        writeProjectWorkspaceFile: vi.fn().mockResolvedValue({}),
        createGezel: vi.fn().mockResolvedValue({ id: 'pia' }),
        addGezelToProject: vi.fn().mockResolvedValue({}),
        sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
      };
      const ctx = { client, log: vi.fn() } as unknown as EvalContext;

      await fictionalSdkScenario.setup?.(ctx);

      expect(client.sendChatMessage).toHaveBeenCalledWith(
        'pia',
        expect.objectContaining({
          projectId: 'quill-project',
          message: expect.stringContaining('caller-pinned trusted checker'),
          expectedDeliverable: {
            kind: 'file',
            filePath: WORKER_PATH,
            scripts: [
              {
                name: 'checkWorkspaceScript',
                scope: 'standard',
                inputs: {
                  script: RUN_PATH,
                  expectedSource: QUILL_RUN_MJS,
                  timeoutMs: 120_000,
                },
              },
            ],
          },
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
