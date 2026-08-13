import type { ProjectDetail } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { BindingSyncResult } from './manager.js';
import { runConnectorTaskPrep } from './task-prep.js';

function project(): ProjectDetail {
  return {
    id: 'p1',
    name: 'Review project',
    connectors: [{ id: 'issues-1', type: 'github-issues' }],
  } as unknown as ProjectDetail;
}

function deps(result: BindingSyncResult) {
  return {
    getProject: async () => project(),
    allowExternalServices: async () => true,
    sync: async () => result,
  };
}

const input = {
  projectId: 'p1',
  craftbookId: 'issue-review',
  connectors: [{ typeId: 'github-issues' }],
  params: {},
};

describe('runConnectorTaskPrep', () => {
  it('can provision a required zero-config native binding before syncing', async () => {
    let provisioned = false;
    let syncedBinding = '';
    const result = await runConnectorTaskPrep(
      {
        getProject: async () =>
          ({
            id: 'p1',
            name: 'Review project',
            github: { url: 'https://github.com/acme/widget' },
            connectors: [],
          }) as unknown as ProjectDetail,
        allowExternalServices: async () => true,
        ensureBinding: async (_project, need) => {
          provisioned = need.typeId === 'github-pulls';
          return {
            id: 'pulls-auto',
            type: 'github-pulls',
            sourceId: 'bundled',
            version: '1.0.1',
            corpusDir: 'data/github-pulls',
            config: {},
          };
        },
        sync: async (_project, bindingId) => {
          syncedBinding = bindingId;
          return {
            written: 2,
            quarantined: 0,
            skipped: 0,
            pruned: 0,
            errors: 0,
            cursor: undefined,
          };
        },
      },
      {
        projectId: 'p1',
        craftbookId: 'pull-request-review',
        connectors: [{ typeId: 'github-pulls' }],
        params: {},
      },
    );
    expect(provisioned).toBe(true);
    expect(syncedBinding).toBe('pulls-auto');
    expect(result.params).toEqual({});
  });

  it('does not launch a generic connector task after a record-level sync failure', async () => {
    await expect(
      runConnectorTaskPrep(
        deps({
          written: 3,
          quarantined: 0,
          skipped: 0,
          pruned: 0,
          errors: 1,
          cursor: undefined,
        }),
        input,
      ),
    ).rejects.toThrow(/Could not pull down github-issues connector data: 1 record failed to sync/);
  });

  it('does not launch a generic connector task after a rate-limited partial sync', async () => {
    await expect(
      runConnectorTaskPrep(
        deps({
          written: 3,
          quarantined: 0,
          skipped: 0,
          pruned: 0,
          errors: 0,
          cursor: undefined,
          rateLimited: true,
        }),
        input,
      ),
    ).rejects.toThrow(/source rate-limited the sync before it completed/);
  });
});
