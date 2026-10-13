import { MachineMemoryUsageSchema } from '@bendyline/gezel';
import { sampleDarwinSystemMemoryCached } from '@bendyline/gezel-inference/internal/system/darwin-memory';
import { sampleDarwinGezelProcessMemoryCached } from '@bendyline/gezel-inference/internal/system/gezel-process-memory';
import {
  detectMemoryProfileCached,
  sampleMachineMemoryUsage,
  summarizeResidentModels,
} from '@bendyline/gezel-inference/internal/system/memory';
import { Hono } from 'hono';
import type { EngineContext } from '../engine-context.js';
export function systemMemoryRoutes(ctx: EngineContext): Hono {
  const app = new Hono();

  /**
   * Live memory pool behind local inference. This endpoint is intentionally
   * cheap enough to poll while the engine dropdown is open: accelerator
   * capacity is cached, device telemetry is coalesced by DeviceHealthGate,
   * and main-memory use comes from node:os.
   */
  app.get('/usage', async (c) => {
    const [profile, config] = await Promise.all([
      detectMemoryProfileCached(),
      ctx.store.readConfig(),
    ]);
    const configuredBackend =
      config.llamaCppBackendOverride && config.llamaCppBackendOverride !== 'auto'
        ? config.llamaCppBackendOverride
        : (process.env.GEZEL_LLAMA_SERVER_BACKEND ?? process.env.GEZEL_LLAMA_DETECTED_BACKEND);
    const forceMainMemory = configuredBackend === 'cpu';
    const unifiedMemory =
      profile.source === 'darwin-unified' ||
      profile.source === 'gpu-integrated' ||
      profile.gpuMemoryKind === 'unified';
    // Main/UMA memory comes from host counters (`vm_stat` on macOS). Avoid
    // spawning any SMI adapter there or on CPU-only hosts, where it cannot
    // improve this sample.
    const sampleDarwinMemory = profile.platform === 'darwin' && (forceMainMemory || unifiedMemory);
    const [deviceHealth, gezelProcessMemory, darwinSystemMemory] = await Promise.all([
      forceMainMemory || profile.source === 'system-ram-fallback' || unifiedMemory
        ? undefined
        : ctx.gpuArbiter.getDeviceHealthStatus(1_000),
      sampleDarwinMemory ? sampleDarwinGezelProcessMemoryCached({ home: ctx.home }) : null,
      sampleDarwinMemory
        ? sampleDarwinSystemMemoryCached({ totalBytes: profile.totalRamBytes })
        : null,
    ]);
    const engineSnapshot = ctx.chat.peekEngineStatus();
    const engineModelWeightsBytes = (engineSnapshot?.entries ?? []).reduce(
      (sum, entry) =>
        sum + Math.min(entry.modelWeightsBytes ?? entry.residentBytes, entry.residentBytes),
      0,
    );
    const engineLifecycles = (engineSnapshot?.entries ?? []).flatMap((entry) =>
      entry.lifecycle
        ? [
            {
              provider: entry.provider,
              modelId: entry.modelId,
              replicaIdx: entry.replicaIdx,
              ...entry.lifecycle,
            },
          ]
        : [],
    );
    const snapshot = {
      ...sampleMachineMemoryUsage({
        profile,
        ...(deviceHealth ? { deviceHealth } : {}),
        engineCommittedBytes: engineSnapshot?.committedBytes ?? 0,
        engineBudgetBytes: engineSnapshot?.enforced ? engineSnapshot.budgetBytes : null,
        residentModels: summarizeResidentModels(engineSnapshot?.entries ?? []),
        engineLifecycles,
        engineModelWeightsBytes,
        gezelProcessMemory,
        darwinSystemMemory,
        forceMainMemory,
      }),
      enginePools: engineSnapshot?.pools ?? null,
      ...(engineSnapshot?.ramSpillover ? { engineRamSpillover: engineSnapshot.ramSpillover } : {}),
    };
    return c.json(MachineMemoryUsageSchema.parse(snapshot));
  });

  return app;
}
