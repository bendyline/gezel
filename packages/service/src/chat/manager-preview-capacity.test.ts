import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

// The live-RAM half of the context clamp reads this machine's free memory,
// which would make an admission assertion depend on whatever else is running
// on the test host. Pin it high and leave every real estimator in place — the
// budget half is what these tests are about.
vi.mock('../providers/native/capacity-broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/native/capacity-broker.js')>();
  return { ...actual, availableSystemRamBytes: () => 512 * 1024 ** 3 };
});

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const GIB = 1024 ** 3;
const BUDGET_BYTES = 96 * GIB;
/** Weights + 2 slots of KV, as the broker would hold them for this model. */
const RESERVED_BYTES = 68 * GIB;

let home: string;
let modelDir: string;
let manager: ChatManager;

/**
 * A resident engine's reservation, keyed the way the pool keys it.
 * `otherModel` re-attributes the identical byte count to a different model so
 * the two cases differ only in ownership.
 */
function routerWithReservation(opts: { otherModel?: boolean } = {}) {
  const key = opts.otherModel ? 'mlx:some-other-model:0' : 'mlx:local-mlx:0';
  return {
    broker: {
      committed: () => ({
        budgetBytes: BUDGET_BYTES,
        committedBytes: RESERVED_BYTES,
        enforced: true,
        systemRamBytes: 128 * GIB,
        autoBudgetBytes: BUDGET_BYTES,
        overridden: false,
        pools: {
          kind: 'unified' as const,
          vramBytes: 0,
          ramShareBytes: BUDGET_BYTES,
          fastBytes: BUDGET_BYTES,
        },
        ramSpillover: {
          allowed: true,
          auto: true,
          overridden: false,
          coResidencyBytes: BUDGET_BYTES,
        },
        byKey: [{ key, bytes: RESERVED_BYTES }],
      }),
      fastBudgetBytes: () => BUDGET_BYTES,
    },
    pool: { peekProvidersForModel: () => [] },
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-preview-capacity-'));
  modelDir = await mkdtemp(join(tmpdir(), 'gezel-preview-model-'));
  // Uniform full attention, qwen3.6-27b-shaped: 256 KiB/token of f16 KV.
  await writeFile(
    join(modelDir, 'config.json'),
    JSON.stringify({
      num_hidden_layers: 64,
      num_key_value_heads: 4,
      head_dim: 256,
      max_position_embeddings: 262_144,
    }),
  );
  const store = new Store({ home });
  await store.ensureLayout();
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  Object.defineProperty(manager, 'mlxModels', {
    configurable: true,
    value: {
      resolveModel: async () => ({
        id: 'local-mlx',
        name: 'Local MLX',
        approxSizeBytes: 29 * GIB,
        contextWindow: 262_144,
        modelDir,
      }),
    },
  });
});

afterEach(async () => {
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
  await rm(modelDir, { recursive: true, force: true });
});

describe('previewLocalEnginePlan — reservation ownership', () => {
  const useRouter = (router: unknown) => {
    Object.defineProperty(manager, 'engineRouter', { configurable: true, value: router });
  };

  it('does not price a resident model against its own reservation', async () => {
    // The bug: `committed()` totals every replica, so the model already
    // serving chats was quoted as if a second copy had to load beside it —
    // 68 GB held + 38 GB of weights against a 96 GB budget. Its own row in
    // Settings then read "Won't fit" while it was mid-generation.
    useRouter(routerWithReservation());

    const plan = await manager.previewLocalEnginePlan('mlx', 'local-mlx');

    expect(plan.contextWindow).toBeGreaterThanOrEqual(65_536);
  });

  it('still denies when the same bytes belong to a different model', async () => {
    // The other half of the contract: co-resident models are real memory
    // pressure and must keep denying, or excluding self would just be the
    // admission check switched off.
    useRouter(routerWithReservation({ otherModel: true }));

    await expect(manager.previewLocalEnginePlan('mlx', 'local-mlx')).rejects.toThrow(
      /Not enough memory/,
    );
  });
});
