import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInstructions } from '../chat/instructions.js';
import type { Store } from '../fs/store.js';
import { hasObservationTables } from './query.js';
import { synthRequests, synthRequestsManifest } from './testing/synth.js';
import { ObservationWriter } from './writer.js';

let artifacts: string;

beforeEach(async () => {
  artifacts = await mkdtemp(join(tmpdir(), 'gezel-obs-gate-'));
});
afterEach(async () => {
  await rm(artifacts, { recursive: true, force: true }).catch(() => {});
});

function store(): Store {
  return { projectArtifactsDir: () => artifacts } as unknown as Store;
}

/**
 * The gate decides whether three tools appear in every system prompt's tool
 * listing for this project. Getting it wrong in the permissive direction is
 * not a security problem but a prompt-budget one, and a model that sees a
 * tool tends to reach for it.
 */
describe('hasObservationTables', () => {
  it('is false for a project with no connectors at all', async () => {
    expect(await hasObservationTables(store(), { id: 'p1' })).toBe(false);
  });

  it('is false for a document corpus — bindings alone are not enough', async () => {
    expect(
      await hasObservationTables(store(), {
        id: 'p1',
        connectors: [{ id: 'b1', type: 'mail-gmail', corpusDir: 'data/mail' }],
      }),
    ).toBe(false);
  });

  it('is true once a binding has landed a table', async () => {
    const writer = new ObservationWriter({
      storageDir: artifacts,
      corpusDir: 'data/traffic',
      manifests: new Map([['requests', synthRequestsManifest('requests') as never]]),
    });
    await writer.writeBatch({ table: 'requests', rows: synthRequests({ rows: 5 }) });
    await writer.finish();

    expect(
      await hasObservationTables(store(), {
        id: 'p1',
        connectors: [{ id: 'b1', type: 'mock-traffic', corpusDir: 'data/traffic' }],
      }),
    ).toBe(true);
  });
});

describe('the Connected data prompt block', () => {
  const base = {
    gezelName: 'Ada',
    about: 'A data analyst.',
    project: {
      id: 'p1',
      name: 'Ops',
      connectors: [
        {
          id: 'b1',
          type: 'mock-traffic',
          displayName: 'Web traffic',
          corpusDir: 'data/traffic',
          config: {},
          lastSyncedAt: '2026-08-04T00:00:00Z',
        },
      ],
    },
  } as unknown as Parameters<typeof buildInstructions>[0];

  it('routes a project with tables to the grounding step', () => {
    const built = buildInstructions({ ...base, hasObservationTables: true });
    expect(built.full).toContain('### Data tables');
    expect(built.full).toContain('describe_table');
    expect(built.full).toContain('query_table');
    // The instruction that matters: do not point read_artifact at Parquet.
    expect(built.full).toMatch(/query rather than read/);
    // And the one the whole scaling argument rests on.
    expect(built.full).toMatch(/Aggregate in the query/);
  });

  it('says nothing about tables for a document-only project', () => {
    const built = buildInstructions({ ...base, hasObservationTables: false });
    expect(built.full).toContain('### Connected data');
    expect(built.full).not.toContain('### Data tables');
    expect(built.full).not.toContain('query_table');
  });

  it('renders for a workspace-only project, which has no connectors at all', () => {
    // The whole reason the block is standalone: a project can hold nothing but
    // spreadsheets, and the connector section it used to ride inside would
    // never render for it.
    const noConnectors = { ...base, project: { id: 'p1', name: 'Ops' } } as typeof base;
    const built = buildInstructions({ ...noConnectors, hasObservationTables: true });
    expect(built.full).not.toContain('### Connected data');
    expect(built.full).toContain('### Data tables');
  });

  it('leaves a prompt with no data and no connectors byte-identical', () => {
    // Prefix-cache stability still holds where it can: a project with neither
    // bindings nor tables produces exactly the same bytes as before the
    // feature existed.
    const bare = { ...base, project: { id: 'p1', name: 'Ops' } } as typeof base;
    const off = buildInstructions({ ...bare, hasObservationTables: false });
    expect(off.full).not.toContain('### Connected data');
    expect(off.full).not.toContain('### Data tables');
  });
});
