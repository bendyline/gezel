import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { writeSyntheticGguf } from '../providers/llama-cpp/gguf-test-fixture.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

// The live-RAM half of the context clamp reads this machine's free memory,
// which would make an admission assertion depend on whatever else is running
// on the test host. Pin it high and leave every real estimator in place — the
// budget half is what these tests are about.
const availableSystemRamBytesMock = vi.hoisted(() => vi.fn(() => 512 * 1024 ** 3));
vi.mock('../providers/native/capacity-broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/native/capacity-broker.js')>();
  return { ...actual, availableSystemRamBytes: availableSystemRamBytesMock };
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
/** Usable VRAM on the ~12 GB card, after the broker's 0.95 fraction. */
const DISCRETE_VRAM_BYTES = Math.floor(11.3 * GIB);
/** What the broker admits against once the card and the RAM share are summed. */
const DISCRETE_BUDGET_BYTES = 30 * GIB;

let home: string;
let modelDir: string;
let ggufPath: string;
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
  availableSystemRamBytesMock.mockReset();
  availableSystemRamBytesMock.mockReturnValue(512 * GIB);
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
  // Header-only: the geometry keys are absent on purpose, so admission
  // prices KV with the weights-scaled heuristic rather than exact geometry.
  ggufPath = join(modelDir, 'model.gguf');
  writeSyntheticGguf(ggufPath, { architecture: 'qwen3moe' });
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

  it('prices inventory projections as if the model were the only resident engine', async () => {
    // Settings answers device fitness, not the transient question "can this
    // model coexist with everything warm right now?". The live launch path
    // retains the denial above and can evict the other model when it is idle.
    useRouter(routerWithReservation({ otherModel: true }));

    const plan = await manager.previewLocalEnginePlan('mlx', 'local-mlx', {
      standalone: true,
    });

    expect(plan.contextWindow).toBeGreaterThanOrEqual(65_536);
    expect(plan.plannedResidentBytes).toBeGreaterThan(0);
  });

  it('forwards standalone through previewContextWindowForModel', async () => {
    // The Codex setup source prices models through this wrapper and writes the
    // result into a profile on disk. It swallowed the denial below into
    // `undefined` and fell back to the 64K floor, so a host admitting 128K+
    // published 65536 for every model and Codex compacted at 90% of that,
    // repeatedly, mid-task. Live pricing stays the default for remote admit.
    useRouter(routerWithReservation({ otherModel: true }));

    await expect(manager.previewContextWindowForModel('mlx', 'local-mlx')).rejects.toThrow(
      /Not enough memory/,
    );
    await expect(
      manager.previewContextWindowForModel('mlx', 'local-mlx', { standalone: true }),
    ).resolves.toBeGreaterThanOrEqual(65_536);
  });

  it('uses live RAM only for imminent admission previews', async () => {
    useRouter(routerWithReservation());
    availableSystemRamBytesMock.mockReturnValue(4 * GIB);

    // Inventory/config previews remain stable under transient system load.
    await expect(
      manager.previewContextWindowForModel('mlx', 'local-mlx'),
    ).resolves.toBeGreaterThanOrEqual(65_536);
    expect(availableSystemRamBytesMock).not.toHaveBeenCalled();

    // Remote /admit asks the imminent-placement question and mirrors launch.
    await expect(
      manager.previewContextWindowForModel('mlx', 'local-mlx', {
        liveSystemPressure: true,
      }),
    ).rejects.toThrow(/Not enough memory/);
    expect(availableSystemRamBytesMock).toHaveBeenCalledOnce();
  });

  it('treats a competing resident engine as queueable during remote admission', async () => {
    useRouter(routerWithReservation({ otherModel: true }));
    availableSystemRamBytesMock.mockReturnValue(4 * GIB);

    await expect(
      manager.previewContextWindowForModel('mlx', 'local-mlx', {
        standalone: true,
        liveSystemPressure: true,
      }),
    ).resolves.toBeGreaterThanOrEqual(65_536);
    expect(availableSystemRamBytesMock).not.toHaveBeenCalled();
  });
});

/**
 * A discrete-GPU host shaped like the reporting machine: ~31 GB RAM and a
 * ~12 GB card, which the broker combines into a 30 GB admission budget.
 */
function discreteGpuRouter() {
  return {
    broker: {
      committed: () => ({
        budgetBytes: DISCRETE_BUDGET_BYTES,
        committedBytes: 0,
        enforced: true,
        systemRamBytes: 31 * GIB,
        autoBudgetBytes: DISCRETE_BUDGET_BYTES,
        overridden: false,
        pools: {
          kind: 'discrete-gpu' as const,
          vramBytes: DISCRETE_VRAM_BYTES,
          ramShareBytes: DISCRETE_BUDGET_BYTES - DISCRETE_VRAM_BYTES,
          fastBytes: DISCRETE_VRAM_BYTES,
          concurrencySizingBytes: DISCRETE_VRAM_BYTES,
        },
        ramSpillover: {
          allowed: true,
          auto: true,
          overridden: false,
          coResidencyBytes: DISCRETE_BUDGET_BYTES,
        },
        byKey: [],
      }),
      fastBudgetBytes: () => DISCRETE_VRAM_BYTES,
    },
    pool: { peekProvidersForModel: () => [] },
  };
}

describe('previewLocalEnginePlan — RAM-spillover models on a discrete GPU', () => {
  it('admits a MoE larger than VRAM but well inside the budget', async () => {
    // The bug: the preview capped its admission clamp at usable VRAM (it
    // passed a literal 0 free RAM), so weights alone overran the cap and no
    // slot count could hold the 64K floor. A 21 GB MoE against a 30 GB budget
    // reported "Won't fit" in Settings while the catalog row beside it read
    // "good match for this machine" — and the broker would in fact have
    // admitted it, spilling experts to RAM exactly as the badge promised.
    // A 4.7 GB model on the same host was denied the same way.
    Object.defineProperty(manager, 'engineRouter', {
      configurable: true,
      value: discreteGpuRouter(),
    });
    Object.defineProperty(manager, 'llamaCppModels', {
      configurable: true,
      value: {
        resolveModel: async () => ({
          id: 'local-moe',
          name: 'Local MoE',
          approxSizeBytes: 21 * GIB,
          contextWindow: 262_144,
          weightsPath: ggufPath,
          architecture: 'qwen3moe',
        }),
      },
    });

    const plan = await manager.previewLocalEnginePlan('llama-cpp', 'local-moe');

    expect(plan.contextWindow).toBeGreaterThanOrEqual(65_536);
  });
});
