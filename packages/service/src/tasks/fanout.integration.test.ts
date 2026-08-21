import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from '../service.js';

// Deterministic, dependency-free embeddings so the memory manager doesn't
// pull a real model (mirrors integration.test.ts).
vi.mock('../memory/embeddings.js', () => {
  const vectorFor = (text: string): number[] => {
    const vector = new Array<number>(16).fill(0);
    for (let i = 0; i < text.length; i++) vector[i % vector.length]! += text.charCodeAt(i) / 255;
    const magnitude = Math.hypot(...vector) || 1;
    return vector.map((v) => v / magnitude);
  };
  class EmbeddingsDisabledError extends Error {
    readonly code = 'EMBEDDINGS_DISABLED';
  }
  return {
    EmbeddingsDisabledError,
    embeddingsDisabledReason: () => null,
    embed: async (t: string) => vectorFor(t),
    embedQuery: async (t: string) => vectorFor(t),
    embedBatch: async (ts: string[]) => ts.map(vectorFor),
  };
});

let svc: RunningService;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  const home = await mkdtemp(join(tmpdir(), 'gezel-fanout-'));
  svc = await startService({ home });
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(svc.context.home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

const BILLABLES = [
  {
    client: 'Harbor & Pine Architects',
    number: '2026-042',
    rate: '1840.00',
    work: 'Signage',
    due: '2026-08-15',
  },
  {
    client: 'Kestrel Coffee Roasters',
    number: '2026-043',
    rate: '2600.00',
    work: 'Packaging',
    due: '2026-07-25',
  },
  {
    client: 'Bluestem Community Fund',
    number: '2026-044',
    rate: '975.00',
    work: 'Annual report',
    due: '2026-08-17',
  },
];

describe('declarative per-item fanout (invoice-run)', () => {
  it('the invoice-run book resolves with a spawn block', async () => {
    const detail = await svc.context.catalog.get('craftbook-template', 'invoice-run');
    expect(detail?.manifest.kind).toBe('craftbook-template');
    if (detail?.manifest.kind !== 'craftbook-template') throw new Error('wrong kind');
    // Catalog manifests retain their launch-time placeholders. Task creation
    // resolves workPath to the concrete per-task artifact folder.
    expect(detail.manifest.spawn?.overFile).toBe('{{workPath}}/billables.json');
    expect(detail.manifest.spawn?.overArtifact).toBe(true);
    expect(detail.manifest.spawn?.steps.length).toBeGreaterThan(0);
  });

  it('a spawnFanout step spawns one dispatchable child per overFile item, idempotently', async () => {
    const { store, tasks } = svc.context;
    const project = await store.createProject({ name: 'Fieldnote Office' });

    const detail = await svc.context.catalog.get('craftbook-template', 'invoice-run');
    if (detail?.manifest.kind !== 'craftbook-template' || !detail.manifest.spawn) {
      throw new Error('invoice-run has no spawn block');
    }
    const spawn = detail.manifest.spawn;

    // Create the spawn host the way the HTTP create route / MCP
    // invoke_craftbook / eval harness do: by craftbookId ALONE, with NO
    // explicit spawnsSteps. `tasks.create` must derive the spawn host from
    // the resolved book's `spawn` block.
    const task = await tasks.create(project.id, {
      title: 'Monthly Invoice Run',
      description: 'Run the month invoicing for the seeded client roster and ledger.',
      craftbookId: 'invoice-run',
      assignee: { kind: 'user' },
      createdBy: { kind: 'user' },
    });

    // Invoker builds a spawn host: spawnsCraftbook present AND the main
    // snapshot carries the resolved spawn config the runtime reads at fanout
    // time. The catalog template itself remains untouched above.
    expect(task.spawnsCraftbook).toBeDefined();
    expect(task.craftbookParams?.workPath).toBe(task.artifactDir);
    expect(task.craftbook.spawn?.overFile).toBe(`${task.artifactDir}/billables.json`);
    expect(task.craftbook.spawn?.overArtifact).toBe(spawn.overArtifact);
    expect(task.activeStepId).toBe('scope');

    // Seed the machine list at the concrete path the scope step would
    // normally produce. Seeding the raw catalog path would create a literal
    // `{{workPath}}` directory and leave the runtime's resolved path empty.
    const resolvedSpawn = task.craftbook.spawn;
    if (!resolvedSpawn) throw new Error('spawn host snapshot has no spawn block');
    const billables = JSON.stringify(BILLABLES, null, 2);
    if (resolvedSpawn.overArtifact) {
      await store.writeProjectArtifact(project.id, resolvedSpawn.overFile, billables);
    } else {
      await store.writeProjectWorkspaceFile(project.id, resolvedSpawn.overFile, billables);
    }

    // Advance scope -> draft (force past scope's gate). Activating the
    // spawnFanout `draft` step fires the runtime fanout.
    await tasks.completeStep(project.id, task.num, 'scope', 'draft', { force: true });

    const children = await tasks.listChildren(task.ref);
    expect(children.length).toBe(BILLABLES.length);

    // Each child dispatches off its ENTRY step's binding, so every child's
    // entry step must carry a concrete gezel — else the fanout would stall.
    for (const child of children) {
      const entry = child.craftbook.steps.find((s) => s.id === child.activeStepId)!;
      const gezelId =
        entry.assignee?.kind === 'gezel' ? entry.assignee.gezelId : entry.suggestedGezelId;
      expect(gezelId, `child ${child.ref} entry step has a gezel`).toBeTruthy();
    }

    // Per-item context landed in each child recipe (interpolated paths).
    const numbers = new Set(BILLABLES.map((b) => `invoices/${b.number}.html`));
    for (const child of children) {
      const entry = child.craftbook.steps.find((s) => s.id === child.activeStepId)!;
      expect(numbers.has(entry.advanceWhen?.file ?? '')).toBe(true);
    }

    // The runtime stamped the step's advanceWhen deliverable and advanced.
    const draftStep = task.craftbook.steps.find((step) => step.id === 'draft');
    if (!draftStep?.advanceWhen) throw new Error('draft step has no deliverable');
    const draftManifest = draftStep.advanceWhen.artifact
      ? await store.readProjectArtifact(project.id, draftStep.advanceWhen.file)
      : await store.readProjectWorkspaceFile(project.id, draftStep.advanceWhen.file);
    expect(draftManifest).toBeTruthy();

    // Idempotency: re-activating the draft step must not double-spawn. The
    // fanout advanced draft -> collect; loop it back to draft and re-fire.
    const afterFirst = await tasks.get(project.id, task.num);
    await tasks.completeStep(project.id, task.num, afterFirst!.activeStepId!, 'draft', {
      force: true,
    });
    const childrenAfter = await tasks.listChildren(task.ref);
    expect(childrenAfter.length).toBe(BILLABLES.length);
  }, 30_000);
});
