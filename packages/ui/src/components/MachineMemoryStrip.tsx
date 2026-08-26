import type { LocalEngineLifecycle, MachineMemoryUsage } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Tooltip } from '../primitives/index.js';
import { formatBytes } from './engine-pill-stats.js';

interface Props {
  /** Poll only while mounted (the engine dropdown mounts this on open). */
  pollMs?: number;
  /**
   * Catalog display names by model id, for the reservation segments. The
   * memory endpoint carries ids only — resolving names there would put a
   * catalog read in a once-a-second poll — so the host passes down the
   * installed-model list it already holds. Unknown ids fall back to the id.
   */
  modelNames?: ReadonlyMap<string, string>;
  /**
   * Planned engine slots per `provider:modelId`. This belongs beside the
   * reservation because each additional slot contributes another KV cache;
   * naming the slot count makes a multi-slot reservation directly comparable
   * with the model list's single-chat memory estimate.
   *
   * A slot is one number: what we reserve KV for is what can generate. The
   * engine pill states it here and nowhere else — who is occupying the slots
   * (chat vs background) belongs to the queue popover, not to this strip.
   */
  modelConcurrentSlots?: ReadonlyMap<string, number>;
}

function poolLabel(kind: MachineMemoryUsage['kind']): string {
  if (kind === 'vram') return 'Video memory';
  if (kind === 'ram') return 'RAM';
  return 'Unified memory';
}

function percent(bytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, (bytes / totalBytes) * 100));
}

function formatCountdown(unloadAt: number): string {
  const remainingSeconds = Math.max(0, Math.ceil((unloadAt - Date.now()) / 1_000));
  if (remainingSeconds <= 0) return 'Unloading now';
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `Unloads in ${minutes}:${String(seconds).padStart(2, '0')}`;
}

type UnloadableProvider = 'llama-cpp' | 'mlx' | 'ds4';

function isUnloadableProvider(provider: string): provider is UnloadableProvider {
  return provider === 'llama-cpp' || provider === 'mlx' || provider === 'ds4';
}

function lifecycleKey(engine: LocalEngineLifecycle): string {
  return `${engine.provider}:${engine.modelId}:${engine.replicaIdx}`;
}

function gpuOwnerLabel(
  owner: NonNullable<MachineMemoryUsage['gpuProcesses']>[number]['owner'],
): string {
  if (owner === 'machine-engine') return 'Gezel machine engine';
  if (owner === 'development-engine') return 'Gezel development engine';
  if (owner === 'app-engine') return 'Gezel app engine';
  if (owner === 'gezel-engine') return 'Gezel engine';
  return 'Other app';
}

type GpuProcess = NonNullable<MachineMemoryUsage['gpuProcesses']>[number];

function gpuProcessDisplayName(name: string | undefined): string | null {
  const friendly = name?.trim().replace(/\.exe$/i, '');
  if (!friendly) return null;
  return friendly.toLowerCase() === 'dwm' ? 'Windows Desktop' : friendly;
}

function gpuProcessRowLabel(process: GpuProcess): string {
  const name = gpuProcessDisplayName(process.name);
  if (name === 'Windows Desktop') return name;
  return name ? `${gpuOwnerLabel(process.owner)} · ${name}` : gpuOwnerLabel(process.owner);
}

/**
 * The broker reservation is not a quantity of this pool: on a discrete card
 * its budget is the card's memory PLUS a share of system RAM, so it routinely
 * exceeds what the bar can hold. State it against its own budget and never as
 * a fraction of the pool.
 */
function describeReservation(usage: MachineMemoryUsage): string {
  const reserved = `~${formatBytes(usage.engineReservedBytes)}`;
  if (usage.engineBudgetBytes === null || usage.engineBudgetBytes <= 0) {
    return `Models reserve ${reserved} for capacity planning; this can include models that are not running`;
  }
  const budget = `~${formatBytes(usage.engineBudgetBytes)}`;
  return usage.kind === 'vram'
    ? `Models reserve ${reserved} of ${budget} — this card's memory plus a share of system memory`
    : `Models reserve ${reserved} of ${budget} available to models`;
}

function describeCapacityPools(
  usage: MachineMemoryUsage,
  usesOnCardCeiling: boolean,
  residentReplicaCount: number,
  physicalMemoryScale: { modelCapacityBytes: number; systemReserveBytes: number } | null,
): string | null {
  if (physicalMemoryScale) {
    const memoryLabel = usage.kind === 'unified' ? 'unified memory' : 'system RAM';
    return `Scale: ~${formatBytes(physicalMemoryScale.modelCapacityBytes)} model capacity + ~${formatBytes(
      physicalMemoryScale.systemReserveBytes,
    )} system reserve = ${formatBytes(usage.totalBytes)} ${memoryLabel}`;
  }
  const pools = usage.enginePools;
  if (!pools) return null;
  if (pools.kind === 'discrete-gpu') {
    const spillover = usage.engineRamSpillover;
    if (spillover && !spillover.allowed) {
      if (usesOnCardCeiling) {
        return `Concurrent models stay within ~${formatBytes(spillover.coResidencyBytes)} of graphics memory; system memory is allowed only for a single model too large for the card`;
      }
      if (residentReplicaCount <= 1) {
        return `This single model may use ~${formatBytes(pools.vramBytes)} of graphics memory plus system memory; additional models will unload it rather than spill together`;
      }
      return `Current reservations exceed the ~${formatBytes(spillover.coResidencyBytes)} on-card limit; the next model load will serialize them`;
    }
    return `Capacity: ~${formatBytes(pools.vramBytes)} video memory + ~${formatBytes(pools.ramShareBytes)} system RAM`;
  }
  if (pools.kind === 'unified') {
    return `Capacity: ~${formatBytes(pools.ramShareBytes)} unified memory`;
  }
  return `Capacity: ~${formatBytes(pools.ramShareBytes)} system RAM`;
}

/**
 * Stacked live view of the physical memory pool backing local inference.
 *
 * macOS reports Gezel's observed physical footprint (including Metal-backed
 * allocations); Windows reports dedicated bytes by process through the OS GPU
 * counters. Both stay separate from the engine broker's capacity reservation.
 * Aggregate used/free figures come from the OS on UMA/CPU hosts and the GPU
 * driver on discrete cards. macOS file cache stays separate because it is
 * reclaimable capacity, not "Other" app use.
 *
 * A discrete card whose driver reports capacity but not use omits the live-use
 * bar rather than showing an unactionable unknown meter or filling it from the
 * reservation. The broker reservation gets a separate capacity meter. On a
 * discrete GPU with spillover off, that meter uses the on-card co-residency
 * ceiling; a single oversized model still uses the combined-pool denominator.
 * See the service-side note in `sampleMachineMemoryUsage`.
 */
export function MachineMemoryStrip({ pollMs = 1_000, modelNames, modelConcurrentSlots }: Props) {
  const [usage, setUsage] = useState<MachineMemoryUsage | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [unloadingEngines, setUnloadingEngines] = useState<ReadonlySet<string>>(() => new Set());
  const [unloadError, setUnloadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const sample = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await api.getMachineMemoryUsage();
        if (cancelled) return;
        setUsage(next);
        setUnavailable(false);
      } catch {
        if (!cancelled) setUnavailable(true);
      } finally {
        pending = false;
      }
    };
    void sample();
    const timer = setInterval(() => void sample(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  const unloadNow = async (engine: LocalEngineLifecycle, engineLabel: string) => {
    if (!isUnloadableProvider(engine.provider)) return;
    const key = lifecycleKey(engine);
    setUnloadError(null);
    setUnloadingEngines((current) => new Set(current).add(key));
    try {
      await api.unloadIdleEngine({
        provider: engine.provider,
        modelId: engine.modelId,
        replicaIdx: engine.replicaIdx,
      });
      // Remove the completed release immediately; the refreshed sample below
      // fills in the corresponding measured-use and reservation changes.
      setUsage((current) =>
        current
          ? {
              ...current,
              engineLifecycles: current.engineLifecycles?.filter(
                (candidate) => lifecycleKey(candidate) !== key,
              ),
            }
          : current,
      );
      try {
        const next = await api.getMachineMemoryUsage();
        setUsage(next);
        setUnavailable(false);
      } catch {
        setUnavailable(true);
      }
    } catch (error) {
      setUnloadError(
        `Could not unload ${engineLabel}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setUnloadingEngines((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  if (!usage) {
    return (
      <span className="machine-memory-unavailable">
        {unavailable ? 'Memory telemetry unavailable' : 'Measuring memory…'}
      </span>
    );
  }
  if (usage.totalBytes <= 0) {
    return <span className="machine-memory-unavailable">Memory capacity unavailable</span>;
  }

  const label = poolLabel(usage.kind);
  const hasMeasuredUsage = usage.usedBytes !== null;
  const measuredUsageLabel =
    usage.kind === 'vram'
      ? 'Current video memory use'
      : usage.kind === 'ram'
        ? 'Current RAM use'
        : 'Current memory use';
  const usedSummary =
    usage.usedBytes === null
      ? `${formatBytes(usage.totalBytes)} total`
      : `${formatBytes(usage.usedBytes)} of ${formatBytes(usage.totalBytes)} used`;
  const observed = typeof usage.gezelBytesObserved === 'number';
  const processAttributionEstimated = usage.processAttributionKind === 'estimated';
  const gezelApproximate = !observed || processAttributionEstimated;
  const gezelBytes = usage.gezelBytesObserved ?? usage.gezelBytesEstimated;
  const otherLabel = usage.kind === 'vram' && !observed ? 'Unattributed' : 'Other';
  const unattributedDescription =
    'Per-process video memory use is unavailable; this may include retained Gezel models';
  const otherPercent = usage.otherBytes === null ? 0 : percent(usage.otherBytes, usage.totalBytes);
  const cachedBytes = typeof usage.cachedBytes === 'number' ? usage.cachedBytes : null;
  const cachedPercent = cachedBytes === null ? 0 : percent(cachedBytes, usage.totalBytes);
  // Process accounting can give us a Gezel total, but not a trustworthy
  // per-model weights/cache split. The broker can retain capacity for a cold
  // provider whose process is not running, so applying that estimate to the
  // attributed footprint invents detail. Keep that total whole.
  const gezelSegments = observed
    ? [
        {
          key: 'observed',
          label: 'Gezel',
          detail: processAttributionEstimated
            ? 'estimated from current local-engine video memory residency'
            : 'measured daemon and running local-engine footprint',
          bytes: gezelBytes,
        },
      ]
    : [
        {
          key: 'infra',
          label: 'Core Gezel infra',
          detail: 'daemon and local-engine runtime',
          bytes: usage.gezelInfraBytes,
        },
        {
          key: 'weights',
          label: 'Model weights',
          detail: 'resident model parameters',
          bytes: usage.gezelModelWeightsBytes,
        },
        {
          key: 'cache',
          label: 'Model cache',
          detail: 'KV cache and inference buffers',
          bytes: usage.gezelModelCacheBytes,
        },
      ];
  const residentModels = usage.residentModels ?? [];
  const attributed = gezelBytes > 0;
  const hasMeasuredLegend =
    attributed || usage.otherBytes !== null || cachedBytes !== null || usage.freeBytes !== null;
  const reservationBudgetBytes = usage.engineBudgetBytes ?? 0;
  const residentReplicaCount = residentModels.reduce((sum, model) => sum + model.replicaCount, 0);
  const spillover = usage.engineRamSpillover;
  const coResidencyBytes = spillover?.coResidencyBytes ?? 0;
  const usesOnCardCeiling =
    usage.enginePools?.kind === 'discrete-gpu' &&
    spillover?.allowed === false &&
    coResidencyBytes > 0 &&
    usage.engineReservedBytes <= coResidencyBytes;
  const effectiveReservationBudgetBytes = usesOnCardCeiling
    ? coResidencyBytes
    : reservationBudgetBytes;
  const hasReservationMeter = usage.engineReservedBytes > 0 && effectiveReservationBudgetBytes > 0;
  const reservationNote =
    usage.engineReservedBytes > 0 && !hasReservationMeter ? describeReservation(usage) : null;
  // Unified-memory and CPU inference draw from the same physical RAM shown in
  // the live-use meter above. Use that physical total as this meter's scale as
  // well, then show the part held back from models explicitly. A 98 GiB model
  // reservation on a 128 GiB Mac with a 112 GiB model budget is therefore
  // 98/128 wide, followed by 14 GiB of model headroom and a 16 GiB system
  // reserve. Discrete-GPU capacity still spans two different pools, so its
  // denominator remains the combined broker budget.
  const usesPhysicalMemoryScale =
    !usesOnCardCeiling &&
    (usage.kind === 'unified' || usage.kind === 'ram') &&
    effectiveReservationBudgetBytes <= usage.totalBytes;
  const reservationScaleBytes = usesPhysicalMemoryScale
    ? usage.totalBytes
    : effectiveReservationBudgetBytes;
  const systemReserveBytes = usesPhysicalMemoryScale
    ? Math.max(0, usage.totalBytes - effectiveReservationBudgetBytes)
    : 0;
  const systemReservePercent = percent(systemReserveBytes, reservationScaleBytes);
  const capacityPoolSummary = describeCapacityPools(
    usage,
    usesOnCardCeiling,
    residentReplicaCount,
    usesPhysicalMemoryScale
      ? { modelCapacityBytes: effectiveReservationBudgetBytes, systemReserveBytes }
      : null,
  );
  const vramCapacityPercent =
    hasReservationMeter && usage.enginePools?.kind === 'discrete-gpu'
      ? percent(usage.enginePools.vramBytes, effectiveReservationBudgetBytes)
      : 0;
  const ramCapacityPercent =
    hasReservationMeter && usesPhysicalMemoryScale
      ? percent(effectiveReservationBudgetBytes, reservationScaleBytes)
      : hasReservationMeter && usage.enginePools
        ? Math.min(
            100 - vramCapacityPercent,
            percent(usage.enginePools.ramShareBytes, effectiveReservationBudgetBytes),
          )
        : 0;
  const reservationSegments =
    residentModels.length > 0
      ? residentModels.map((model) => {
          const key = `${model.provider}:${model.modelId}`;
          const slotsPerReplica = modelConcurrentSlots?.get(key);
          const concurrentSlots =
            slotsPerReplica !== undefined ? slotsPerReplica * model.replicaCount : undefined;
          return {
            key,
            label: `${modelNames?.get(model.modelId) ?? model.modelId}${
              model.replicaCount > 1 ? ` ×${model.replicaCount}` : ''
            }${concurrentSlots !== undefined && concurrentSlots > 1 ? ` · ${concurrentSlots} slots` : ''}`,
            bytes: model.reservedBytes,
          };
        })
      : [
          {
            key: 'all-models',
            label: 'Local models',
            bytes: usage.engineReservedBytes,
          },
        ];
  const reservationAriaSummary = hasReservationMeter
    ? [
        `${usesOnCardCeiling ? 'On-card model capacity' : 'Model capacity'}: about ${formatBytes(
          usage.engineReservedBytes,
        )} of ${formatBytes(effectiveReservationBudgetBytes)} reserved`,
        capacityPoolSummary,
        ...reservationSegments.map(
          (segment) => `${segment.label} about ${formatBytes(segment.bytes)} reserved`,
        ),
        systemReserveBytes > 0 ? `System reserve about ${formatBytes(systemReserveBytes)}` : null,
        'Reservation is capacity planning, not measured use; it can include models that are not running',
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  const processDetailThresholdBytes = 16 * 1024 ** 2;
  const allGpuProcesses = usage.gpuProcesses ?? [];
  const displayableGpuProcesses = allGpuProcesses.filter(
    (process) => process.dedicatedBytes >= processDetailThresholdBytes,
  );
  const smallProcessBytes = allGpuProcesses
    .filter((process) => process.dedicatedBytes < processDetailThresholdBytes)
    .reduce((sum, process) => sum + process.dedicatedBytes, 0);
  const needsProcessRemainder =
    displayableGpuProcesses.length > 8 || smallProcessBytes >= processDetailThresholdBytes;
  const gpuProcesses = displayableGpuProcesses.slice(0, needsProcessRemainder ? 7 : 8);
  const visibleProcessBytes = gpuProcesses.reduce(
    (sum, process) => sum + process.dedicatedBytes,
    0,
  );
  const remainingProcessBytes = Math.max(
    0,
    allGpuProcesses.reduce((sum, process) => sum + process.dedicatedBytes, 0) - visibleProcessBytes,
  );
  const showProcessRemainder = remainingProcessBytes >= processDetailThresholdBytes;
  const engineLifecycles = usage.engineLifecycles ?? [];
  const ariaSummary = [
    `${hasMeasuredUsage ? measuredUsageLabel : label}: ${usedSummary}`,
    !attributed
      ? null
      : observed
        ? `Gezel ${processAttributionEstimated ? 'estimated' : 'observed'} footprint ${formatBytes(gezelBytes)}`
        : `Gezel estimated ${formatBytes(gezelBytes)}`,
    ...gezelSegments.map((segment) =>
      segment.bytes > 0 ? `${segment.label} about ${formatBytes(segment.bytes)}` : null,
    ),
    reservationNote,
    usage.orphanedGezelEngineProcessCount > 0
      ? `${usage.orphanedGezelEngineProcessCount} leftover Gezel engine ${
          usage.orphanedGezelEngineProcessCount === 1 ? 'process' : 'processes'
        } from an earlier service session`
      : null,
    usage.otherBytes === null
      ? null
      : `${otherLabel.toLowerCase()} use ${formatBytes(usage.otherBytes)}${
          otherLabel === 'Unattributed' ? '; this may include retained Gezel models' : ''
        }`,
    cachedBytes === null
      ? null
      : `model and file cache ${formatBytes(cachedBytes)}, reclaimable by the operating system`,
    usage.freeBytes === null ? null : `free ${formatBytes(usage.freeBytes)}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="machine-memory-strip">
      <div className="machine-memory-heading">
        <span>
          {hasMeasuredUsage ? measuredUsageLabel : label}
          {usage.kind === 'ram' && <span className="machine-memory-context"> · CPU inference</span>}
        </span>
        <span>{usedSummary}</span>
      </div>
      {hasMeasuredUsage && (
        <Tooltip.Provider delayDuration={150}>
          <div className="machine-memory-bar" role="img" aria-label={ariaSummary}>
            {gezelSegments.map((segment) =>
              segment.bytes > 0 ? (
                <Tooltip.Root key={segment.key}>
                  <Tooltip.Trigger asChild>
                    <span
                      className={`machine-memory-segment machine-memory-segment-gezel machine-memory-segment-gezel-${segment.key}`}
                      style={{ width: `${percent(segment.bytes, usage.totalBytes)}%` }}
                      aria-label={`${segment.label}, about ${formatBytes(segment.bytes)}`}
                    />
                  </Tooltip.Trigger>
                  <Tooltip.Content>
                    {segment.label} · ~{formatBytes(segment.bytes)} ({segment.detail})
                  </Tooltip.Content>
                </Tooltip.Root>
              ) : null,
            )}
            <span
              className="machine-memory-segment machine-memory-segment-other"
              style={{ width: `${otherPercent}%` }}
            />
            {cachedBytes !== null && cachedBytes > 0 && (
              <span
                className="machine-memory-segment machine-memory-segment-cached"
                style={{ width: `${cachedPercent}%` }}
              />
            )}
          </div>
        </Tooltip.Provider>
      )}
      {hasMeasuredLegend && (
        <div className="machine-memory-legend">
          {attributed && (
            <span>
              <i className="machine-memory-swatch machine-memory-swatch-gezel" aria-hidden />
              Gezel {gezelApproximate ? '~' : ''}
              {formatBytes(gezelBytes)}
            </span>
          )}
          {usage.otherBytes !== null && (
            <span title={otherLabel === 'Unattributed' ? unattributedDescription : undefined}>
              <i className="machine-memory-swatch machine-memory-swatch-other" aria-hidden />
              {otherLabel} {formatBytes(usage.otherBytes)}
            </span>
          )}
          {cachedBytes !== null && (
            <span title="Memory-mapped model files and other reclaimable file cache">
              <i className="machine-memory-swatch machine-memory-swatch-cached" aria-hidden />
              Model &amp; file cache {formatBytes(cachedBytes)}
            </span>
          )}
          {usage.freeBytes !== null && (
            <span>
              <i className="machine-memory-swatch machine-memory-swatch-free" aria-hidden />
              Free {formatBytes(usage.freeBytes)}
            </span>
          )}
        </div>
      )}
      {(gpuProcesses.length > 0 || showProcessRemainder) && (
        <div
          className="machine-memory-detail-list"
          aria-label={
            processAttributionEstimated
              ? 'Estimated video memory use'
              : 'Dedicated video memory owners'
          }
        >
          <div className="machine-memory-detail-heading">
            {processAttributionEstimated
              ? 'Estimated video memory use'
              : 'Dedicated video memory owners'}
          </div>
          {gpuProcesses.map((process) => (
            <div
              className="machine-memory-detail-row"
              key={`${process.pid}:${process.adapterLuid ?? 'all'}:${process.owner}`}
            >
              <span>{gpuProcessRowLabel(process)}</span>
              <span>
                {processAttributionEstimated ? '~' : ''}
                {formatBytes(process.dedicatedBytes)}
              </span>
            </div>
          ))}
          {showProcessRemainder && (
            <div className="machine-memory-detail-row">
              <span>Other processes</span>
              <span>
                {processAttributionEstimated ? '~' : ''}
                {formatBytes(remainingProcessBytes)}
              </span>
            </div>
          )}
        </div>
      )}
      {engineLifecycles.length > 0 && (
        <div className="machine-memory-detail-list" aria-label="Local model release schedule">
          <div className="machine-memory-detail-heading">Model release</div>
          {engineLifecycles.map((engine) => {
            const engineLabel = modelNames?.get(engine.modelId) ?? engine.modelId;
            const key = lifecycleKey(engine);
            const canUnloadNow =
              engine.running &&
              !engine.active &&
              engine.unloadAt !== null &&
              isUnloadableProvider(engine.provider);
            const unloading = unloadingEngines.has(key);
            const releaseText = !engine.running
              ? 'Released'
              : engine.active
                ? 'In use'
                : engine.unloadAt !== null
                  ? `${engine.releaseReason === 'memory-pressure' ? 'Video memory pressure · ' : ''}${formatCountdown(engine.unloadAt)}`
                  : 'Resident';
            return (
              <div className="machine-memory-detail-row" key={key}>
                <span>{engineLabel}</span>
                <span className="machine-memory-release-state">
                  <span>{releaseText}</span>
                  {canUnloadNow && (
                    <button
                      type="button"
                      className="secondary machine-memory-unload-button"
                      aria-label={`Unload ${engineLabel}${engine.replicaIdx > 0 ? ` replica ${engine.replicaIdx + 1}` : ''} now`}
                      disabled={unloading}
                      onClick={() => void unloadNow(engine, engineLabel)}
                    >
                      {unloading ? 'Unloading…' : 'Unload now'}
                    </button>
                  )}
                </span>
              </div>
            );
          })}
          {unloadError && (
            <div className="machine-memory-unload-error error" role="alert">
              {unloadError}
            </div>
          )}
        </div>
      )}
      {hasReservationMeter && (
        <div className="machine-memory-reservation">
          <div className="machine-memory-reservation-heading">
            <span>{usesOnCardCeiling ? 'On-card model capacity' : 'Reserved model capacity'}</span>
            <span>
              {`~${formatBytes(usage.engineReservedBytes)} of ~${formatBytes(
                effectiveReservationBudgetBytes,
              )} reserved`}
            </span>
          </div>
          <div
            className="machine-memory-reservation-bar"
            role="img"
            aria-label={reservationAriaSummary}
          >
            {usage.enginePools && (
              <span className="machine-memory-reservation-pools" aria-hidden>
                <i
                  className="machine-memory-reservation-pool machine-memory-reservation-pool-vram"
                  style={{ width: `${vramCapacityPercent}%` }}
                />
                <i
                  className="machine-memory-reservation-pool machine-memory-reservation-pool-ram"
                  style={{ width: `${ramCapacityPercent}%` }}
                />
              </span>
            )}
            {systemReserveBytes > 0 && (
              <span
                className="machine-memory-reservation-system-reserve"
                style={{ width: `${systemReservePercent}%` }}
                title={`System reserve · ~${formatBytes(systemReserveBytes)}`}
                aria-hidden
              />
            )}
            <span className="machine-memory-reservation-segments" aria-hidden>
              {reservationSegments.map((segment) => (
                <i
                  key={segment.key}
                  className="machine-memory-reservation-segment"
                  style={{ width: `${percent(segment.bytes, reservationScaleBytes)}%` }}
                  title={`${segment.label} · ~${formatBytes(segment.bytes)} reserved`}
                />
              ))}
            </span>
            {vramCapacityPercent > 0 && ramCapacityPercent > 0 && (
              <i
                className="machine-memory-reservation-boundary"
                style={{ left: `${vramCapacityPercent}%` }}
                aria-hidden
              />
            )}
            {systemReservePercent > 0 && (
              <i
                className="machine-memory-reservation-boundary machine-memory-reservation-system-boundary"
                style={{ left: `${100 - systemReservePercent}%` }}
                aria-hidden
              />
            )}
          </div>
          {capacityPoolSummary && !usesPhysicalMemoryScale && (
            <div className="machine-memory-reservation-pools-label">{capacityPoolSummary}</div>
          )}
          {residentModels.length > 0 && (
            <div className="machine-memory-reservation-models" aria-label="Model reservations">
              {reservationSegments.map((segment) => (
                <div className="machine-memory-reservation-model" key={segment.key}>
                  <span>{segment.label}</span>
                  <span>~{formatBytes(segment.bytes)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {reservationNote && <div className="machine-memory-note">{reservationNote}</div>}
      {!hasReservationMeter && usage.engineReservedBytes > 0 && residentModels.length > 0 && (
        <div className="machine-memory-reservation-models" aria-label="Model reservations">
          {reservationSegments.map((segment) => (
            <div className="machine-memory-reservation-model" key={segment.key}>
              <span>{segment.label}</span>
              <span>~{formatBytes(segment.bytes)}</span>
            </div>
          ))}
        </div>
      )}
      {usage.orphanedGezelEngineProcessCount > 0 && (
        <div className="machine-memory-note">
          Includes {usage.orphanedGezelEngineProcessCount} leftover Gezel engine{' '}
          {usage.orphanedGezelEngineProcessCount === 1 ? 'process' : 'processes'} from an earlier
          service session
        </div>
      )}
      {usage.deviceNames.length > 0 && (
        <div className="machine-memory-note machine-memory-device">
          {usage.deviceNames.join(', ')}
        </div>
      )}
      {unavailable && <span className="sr-only">Latest memory refresh failed.</span>}
    </div>
  );
}
