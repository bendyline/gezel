import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

describe('Store project finding lifecycle', () => {
  let home: string;
  let store: Store;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-finding-lifecycle-'));
    store = new Store({ home });
    await store.createProject({ name: 'Code review' });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('persists concurrent updates, settles tasks, and prunes vanished findings', async () => {
    await Promise.all([
      store.setProjectFindingStatus('code-review', 'finding-a', 'in_progress', 'code-review/1'),
      store.setProjectFindingStatus('code-review', 'finding-b', 'resolved'),
    ]);

    expect(await store.readProjectFindingLifecycle('code-review')).toMatchObject({
      'finding-a': { status: 'in_progress', taskRef: 'code-review/1' },
      'finding-b': { status: 'resolved' },
    });

    expect(
      await store.settleProjectFindingsForTask('code-review', 'code-review/1', 'complete'),
    ).toBe(1);
    expect((await store.readProjectFindingLifecycle('code-review'))['finding-a']).toMatchObject({
      status: 'resolved',
      taskRef: 'code-review/1',
    });

    await store.reconcileProjectFindingLifecycle('code-review', new Set(['finding-a']));
    expect(await store.readProjectFindingLifecycle('code-review')).toEqual({
      'finding-a': expect.objectContaining({ status: 'resolved' }),
    });
  });
});
