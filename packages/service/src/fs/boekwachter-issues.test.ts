import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

describe('Store project Boekwachter issue lifecycle', () => {
  let home: string;
  let store: Store;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-boekwachter-issues-'));
    store = new Store({ home });
    await store.createProject({ name: 'Document review' });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('keeps an issue and its BW reference after the file changes', async () => {
    await store.observeProjectBoekwachterReviews('document-review', [
      {
        path: 'docs/guide.md',
        contentHash: 'hash-a',
        issues: [
          {
            severity: 'minor',
            category: 'clarity',
            message: 'The conclusion does not identify an owner.',
            line: 37,
          },
        ],
      },
    ]);

    const [created] = await store.listProjectBoekwachterIssues('document-review');
    expect(created).toMatchObject({
      ref: 'BW-1',
      path: 'docs/guide.md',
      line: 37,
      status: 'open',
      lastSeenContentHash: 'hash-a',
    });

    // A later clean review records that the new file hash was checked without
    // deleting the historical lead or pretending its old line is current.
    await store.observeProjectBoekwachterReviews('document-review', [
      { path: 'docs/guide.md', contentHash: 'hash-b', issues: [] },
    ]);
    const [afterEdit] = await store.listProjectBoekwachterIssues('document-review');
    expect(afterEdit).toMatchObject({
      ref: 'BW-1',
      line: 37,
      lastSeenContentHash: 'hash-a',
      lastCheckedContentHash: 'hash-b',
    });

    // The lifecycle file, rather than the disposable index row, owns identity.
    const reloaded = new Store({ home });
    expect(await reloaded.getProjectBoekwachterIssue('document-review', 'BW-1')).toMatchObject({
      id: created?.id,
      ref: 'BW-1',
      lastSeenContentHash: 'hash-a',
      lastCheckedContentHash: 'hash-b',
    });
  });

  it('reconciles repeat observations and settles a linked fix task', async () => {
    const issue = {
      severity: 'major' as const,
      category: 'accuracy',
      message: 'The stated total disagrees with the list.',
      line: 26,
    };
    await store.observeProjectBoekwachterReviews('document-review', [
      { path: 'NOTICE.md', contentHash: 'hash-a', issues: [issue] },
    ]);
    await store.updateProjectBoekwachterIssue('document-review', 'BW-1', {
      status: 'resolved',
      seen: true,
    });

    // The same semantic lead on fresh content retains its reference, refreshes
    // the advisory line, and reopens as a genuine recurrence.
    await store.observeProjectBoekwachterReviews('document-review', [
      { path: 'NOTICE.md', contentHash: 'hash-b', issues: [{ ...issue, line: 31 }] },
    ]);
    expect(await store.listProjectBoekwachterIssues('document-review')).toEqual([
      expect.objectContaining({
        ref: 'BW-1',
        status: 'open',
        line: 31,
        seenAt: expect.any(String),
      }),
    ]);

    await store.updateProjectBoekwachterIssue('document-review', 'BW-1', {
      status: 'in_progress',
      taskRef: 'document-review/4',
    });
    expect(
      await store.settleProjectBoekwachterIssuesForTask(
        'document-review',
        'document-review/4',
        'complete',
      ),
    ).toBe(1);
    expect(await store.getProjectBoekwachterIssue('document-review', 'BW-1')).toMatchObject({
      status: 'resolved',
      taskRef: 'document-review/4',
      resolvedAt: expect.any(String),
    });
  });

  it('preserves a user dismissal across later model reviews', async () => {
    const issue = {
      severity: 'info' as const,
      category: 'style',
      message: 'Consider shortening the heading.',
      line: 2,
    };
    await store.observeProjectBoekwachterReviews('document-review', [
      { path: 'README.md', contentHash: 'hash-a', issues: [issue] },
    ]);
    await store.updateProjectBoekwachterIssue('document-review', 'BW-1', {
      status: 'dismissed',
      dismissalReason: 'not_an_issue',
    });
    await store.observeProjectBoekwachterReviews('document-review', [
      { path: 'README.md', contentHash: 'hash-b', issues: [{ ...issue, line: 4 }] },
    ]);

    expect(await store.getProjectBoekwachterIssue('document-review', 'BW-1')).toMatchObject({
      status: 'dismissed',
      dismissalReason: 'not_an_issue',
      line: 4,
      lastSeenContentHash: 'hash-b',
    });
  });
});
