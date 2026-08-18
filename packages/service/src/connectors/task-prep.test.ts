import type { ProjectDetail } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { BindingSyncResult } from './manager.js';
import { ConnectorPrepError, runConnectorTaskPrep } from './task-prep.js';

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
    allowConnectorData: async () => true,
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
        allowConnectorData: async () => true,
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

  it('types a posture refusal so the launcher can render the fix instead of a 500', async () => {
    const err = await runConnectorTaskPrep(
      {
        getProject: async () => project(),
        allowConnectorData: async () => false,
        sync: async () => {
          throw new Error('sync must not run under a blocking posture');
        },
      },
      input,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorPrepError);
    const prepErr = err as ConnectorPrepError;
    expect(prepErr.code).toBe('CONNECTOR_PREP_FAILED');
    expect(prepErr.reason).toBe('policy');
    expect(prepErr.typeId).toBe('github-issues');
    expect(prepErr.message).toMatch(/Settings → Security/);
  });

  it('degrades an optional connector under a blocking posture instead of failing the launch', async () => {
    const result = await runConnectorTaskPrep(
      {
        getProject: async () => project(),
        allowConnectorData: async () => false,
        sync: async () => {
          throw new Error('sync must not run under a blocking posture');
        },
      },
      { ...input, connectors: [{ typeId: 'github-issues', optional: true }] },
    );
    expect(result.params).toEqual({});
    expect(result.note).toBeUndefined();
  });

  it('types a failure thrown by a registered prep so its message survives the transport', async () => {
    const err = await runConnectorTaskPrep(
      deps({
        written: 0,
        quarantined: 0,
        skipped: 0,
        pruned: 0,
        errors: 2,
        cursor: undefined,
      }),
      input,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorPrepError);
    expect((err as ConnectorPrepError).reason).toBe('prep');
    expect((err as ConnectorPrepError).message).toMatch(/2 records failed to sync/);
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
