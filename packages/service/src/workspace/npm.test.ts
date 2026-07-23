import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEventEnvelope } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { Store } from '../fs/store.js';
import { runPnpm } from '../packages/pnpm.js';
import { requestNpmInstalls } from './npm.js';

// Stub the pnpm runner so the allowlisted-package case exercises the
// real `installNow` branch without spawning a network `pnpm add`. The
// previous version ran a genuine `pnpm add zod`, which on a cold pnpm
// cache could run past the test budget and leave file handles open —
// the install then timed out and `afterEach`'s `rm` raced pnpm into
// EBUSY. Mocking keeps the test fully in-process and deterministic.
// Override only `runPnpm`; preserve the module's other exports.
vi.mock('../packages/pnpm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/pnpm.js')>();
  return {
    ...actual,
    runPnpm: vi.fn(async () => ({ ok: true, code: 0, stdout: '', stderr: '', log: '' })),
  };
});

let home: string;
let store: Store;
const projectId = 'test-project';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-npm-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  // Seed the workspace dir so requestNpmInstalls's
  // `assertWorkspaceWritable` gate accepts the project. Pattern matches
  // `scripts.test.ts` — direct seed via `projectWorkspaceDir` rather
  // than the higher-level `createProject` so we don't pull in the
  // about/missionObjectives validation.
  const workspaceDir = await store.projectWorkspaceDir(projectId);
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    join(workspaceDir, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, version: '0.0.0' }, null, 2)}\n`,
  );
});

afterEach(async () => {
  vi.clearAllMocks();
  // `maxRetries` + `retryDelay` is generic Windows defensiveness: a
  // freshly-written temp tree can briefly hold a handle (AV scanner,
  // indexer) and race a bare `rm` into EBUSY. Node's built-in retry
  // loop covers it. (pnpm is mocked, so no real install holds files.)
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('requestNpmInstalls — approval question publishing', () => {
  it('publishes a `question_asked` event when packages need approval', async () => {
    // Repro for a reported hang: gezel calls npm_install for a
    // non-allowlisted package, the question gets persisted to disk,
    // but pre-fix nothing told the UI to render the approval card —
    // so the user never saw the prompt and the conversation hung.
    const events: ChatEventEnvelope[] = [];
    const chatEvents = new ChatEventBus();
    chatEvents.subscribeProject('test-project', (envelope) => {
      events.push(envelope);
    });

    const result = await requestNpmInstalls({
      store,
      home,
      projectId: 'test-project',
      packages: [{ package: 'some-non-allowlisted-pkg', version: '^1.0.0' }],
      gezelId: 'linnea',
      sessionId: 'sess-abc',
      chatEvents,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      kind: 'pending-approval',
      package: 'some-non-allowlisted-pkg',
    });
    // The fix in npm.ts: after `writeQuestion`, publish the event.
    const askedEvents = events.filter((e) => e.event.type === 'question_asked');
    expect(askedEvents).toHaveLength(1);
    const asked = askedEvents[0]!.event;
    if (asked.type !== 'question_asked') throw new Error('unreachable');
    expect(asked.question.intent?.kind).toBe('npm-install-approval');
    expect(asked.question.sessionId).toBe('sess-abc');
  });

  it('does NOT publish when all packages are pre-allowlisted', async () => {
    // `zod` ships in the allowlist (see SHIPPED_ALLOWLIST in npm.ts),
    // so it goes straight to `installNow` without an approval question.
    // No `question_asked` event should fire. `runPnpm` is mocked, so the
    // install resolves instantly without touching the network.
    const events: ChatEventEnvelope[] = [];
    const chatEvents = new ChatEventBus();
    chatEvents.subscribeProject('test-project', (envelope) => {
      events.push(envelope);
    });

    const result = await requestNpmInstalls({
      store,
      home,
      projectId: 'test-project',
      packages: [{ package: 'zod', version: '^3' }],
      gezelId: 'linnea',
      sessionId: 'sess-abc',
      chatEvents,
    });

    const askedEvents = events.filter((e) => e.event.type === 'question_asked');
    expect(askedEvents).toHaveLength(0);
    // Prove it took the install path (not the approval path): the
    // outcome is `installed` and the runner saw the resolved spec.
    expect(result.results[0]?.kind).toBe('installed');
    expect(vi.mocked(runPnpm)).toHaveBeenCalledWith(
      ['add', 'zod@^3'],
      expect.objectContaining({ cwd: expect.any(String) }),
    );
  });

  it('still works when chatEvents is omitted (legacy callers)', async () => {
    // Defensive check: the optional `chatEvents` shouldn't be required.
    // Tests / non-chat-context callers can omit it; the question is
    // still persisted, just not announced.
    const result = await requestNpmInstalls({
      store,
      home,
      projectId: 'test-project',
      packages: [{ package: 'some-non-allowlisted-pkg', version: '^1.0.0' }],
      gezelId: 'linnea',
      sessionId: 'sess-abc',
    });
    expect(result.results[0]?.kind).toBe('pending-approval');
  });
});
