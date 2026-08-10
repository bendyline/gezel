import type { MachineMemoryUsage } from '@bendyline/gezel';
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
}

function poolLabel(kind: MachineMemoryUsage['kind']): string {
  if (kind === 'vram') return 'VRAM';
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

function gpuOwnerLabel(
  owner: NonNullable<MachineMemoryUsage['gpuProcesses']>[number]['owner'],
): string {
  if (owner === 'machine-engine') return 'Gezel machine engine';
  if (owner === 'development-engine') return 'Gezel development engine';
  if (owner === 'app-engine') return 'Gezel app engine';
  if (owner === 'gezel-engine') return 'Gezel engine';
  return 'Other app';
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

function describeCapacityPools(usage: MachineMemoryUsage): string | null {
  const pools = usage.enginePools;
  if (!pools) return null;
  if (pools.kind === 'discrete-gpu') {
    return `Capacity: ~${formatBytes(pools.vramBytes)} VRAM + ~${formatBytes(pools.ramShareBytes)} system RAM`;
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
 * reservation. The broker reservation gets a separate capacity meter with its
 * own combined-pool denominator — see the service-side note in
 * `sampleMachineMemoryUsage`.
 */
export function MachineMemoryStrip({ pollMs = 1_000, modelNames }: Props) {
  const [usage, setUsage] = useState<MachineMemoryUsage | null>(null);
  const [unavailable, setUnavailable] = useState(false);

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
      ? 'Current VRAM use'
      : usage.kind === 'ram'
        ? 'Current RAM use'
        : 'Current memory use';
  const usedSummary =
    usage.usedBytes === null
      ? `${formatBytes(usage.totalBytes)} total`
      : `${formatBytes(usage.usedBytes)} of ${formatBytes(usage.totalBytes)} used`;
  const observed = typeof usage.gezelBytesObserved === 'number';
  const gezelBytes = usage.gezelBytesObserved ?? usage.gezelBytesEstimated;
  const otherPercent = usage.otherBytes === null ? 0 : percent(usage.otherBytes, usage.totalBytes);
  const cachedBytes = typeof usage.cachedBytes === 'number' ? usage.cachedBytes : null;
  const cachedPercent = cachedBytes === null ? 0 : percent(cachedBytes, usage.totalBytes);
  // Observed process accounting gives a trustworthy Gezel total, but not a
  // trustworthy per-model weights/cache split. The broker can retain capacity
  // for a cold provider whose process is not running, so applying that estimate
  // to the observed footprint invents detail. Keep the measured total whole.
  const gezelSegments = observed
    ? [
        {
          key: 'observed',
          label: 'Gezel',
          detail: 'measured daemon and running local-engine footprint',
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
  const hasReservationMeter = usage.engineReservedBytes > 0 && reservationBudgetBytes > 0;
  const reservationNote =
    usage.engineReservedBytes > 0 && !hasReservationMeter ? describeReservation(usage) : null;
  const capacityPoolSummary = describeCapacityPools(usage);
  const vramCapacityPercent =
    hasReservationMeter && usage.enginePools?.kind === 'discrete-gpu'
      ? percent(usage.enginePools.vramBytes, reservationBudgetBytes)
      : 0;
  const ramCapacityPercent =
    hasReservationMeter && usage.enginePools
      ? Math.min(
          100 - vramCapacityPercent,
          percent(usage.enginePools.ramShareBytes, reservationBudgetBytes),
        )
      : 0;
  const reservationSegments =
    residentModels.length > 0
      ? residentModels.map((model) => ({
          key: `${model.provider}:${model.modelId}`,
          label: `${modelNames?.get(model.modelId) ?? model.modelId}${
            model.replicaCount > 1 ? ` ×${model.replicaCount}` : ''
          }`,
          bytes: model.reservedBytes,
        }))
      : [
          {
            key: 'all-models',
            label: 'Local models',
            bytes: usage.engineReservedBytes,
          },
        ];
  const reservationAriaSummary = hasReservationMeter
    ? [
        `Model capacity: about ${formatBytes(usage.engineReservedBytes)} of ${formatBytes(
          reservationBudgetBytes,
        )} reserved`,
        capacityPoolSummary,
        ...reservationSegments.map(
          (segment) => `${segment.label} about ${formatBytes(segment.bytes)} reserved`,
        ),
        'Reservation is capacity planning, not measured use; it can include models that are not running',
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  const gpuProcesses = (usage.gpuProcesses ?? [])
    .filter((process) => process.dedicatedBytes >= 16 * 1024 ** 2)
    .slice(0, 8);
  const engineLifecycles = usage.engineLifecycles ?? [];
  const ariaSummary = [
    `${hasMeasuredUsage ? measuredUsageLabel : label}: ${usedSummary}`,
    !attributed
      ? null
      : observed
        ? `Gezel observed footprint ${formatBytes(gezelBytes)}`
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
    usage.otherBytes === null ? null : `other use ${formatBytes(usage.otherBytes)}`,
    cachedBytes === null
      ? null
      : `borrowed for cache ${formatBytes(cachedBytes)}, reclaimable by the operating system`,
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
              Gezel {observed ? '' : '~'}
              {formatBytes(gezelBytes)}
            </span>
          )}
          {usage.otherBytes !== null && (
            <span>
              <i className="machine-memory-swatch machine-memory-swatch-other" aria-hidden />
              Other {formatBytes(usage.otherBytes)}
            </span>
          )}
          {cachedBytes !== null && (
            <span title="Reclaimable file cache available to apps">
              <i className="machine-memory-swatch machine-memory-swatch-cached" aria-hidden />
              Borrowed for cache {formatBytes(cachedBytes)}
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
      {gpuProcesses.length > 0 && (
        <div className="machine-memory-detail-list" aria-label="Dedicated VRAM owners">
          <div className="machine-memory-detail-heading">Dedicated VRAM owners</div>
          {gpuProcesses.map((process) => (
            <div className="machine-memory-detail-row" key={`${process.pid}:${process.owner}`}>
              <span>
                {gpuOwnerLabel(process.owner)}
                {process.name ? ` · ${process.name}` : ''}
              </span>
              <span>{formatBytes(process.dedicatedBytes)}</span>
            </div>
          ))}
        </div>
      )}
      {engineLifecycles.length > 0 && (
        <div className="machine-memory-detail-list" aria-label="Local model release schedule">
          <div className="machine-memory-detail-heading">Model release</div>
          {engineLifecycles.map((engine) => {
            const engineLabel = modelNames?.get(engine.modelId) ?? engine.modelId;
            const releaseText = !engine.running
              ? 'Released'
              : engine.active
                ? 'In use'
                : engine.unloadAt !== null
                  ? `${engine.releaseReason === 'memory-pressure' ? 'VRAM pressure · ' : ''}${formatCountdown(engine.unloadAt)}`
                  : 'Resident';
            return (
              <div
                className="machine-memory-detail-row"
                key={`${engine.provider}:${engine.modelId}:${engine.replicaIdx}`}
              >
                <span>{engineLabel}</span>
                <span>{releaseText}</span>
              </div>
            );
          })}
        </div>
      )}
      {hasReservationMeter && (
        <div className="machine-memory-reservation">
          <div className="machine-memory-reservation-heading">
            <span>Reserved model capacity</span>
            <span>
              ~{formatBytes(usage.engineReservedBytes)} of ~{formatBytes(reservationBudgetBytes)}{' '}
              reserved
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
            <span className="machine-memory-reservation-segments" aria-hidden>
              {reservationSegments.map((segment) => (
                <i
                  key={segment.key}
                  className="machine-memory-reservation-segment"
                  style={{ width: `${percent(segment.bytes, reservationBudgetBytes)}%` }}
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
          </div>
          {capacityPoolSummary && (
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
