import type { MachineMemoryUsage } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Tooltip } from '../primitives/index.js';
import { formatBytes } from './engine-pill-stats.js';

interface Props {
  /** Poll only while mounted (the engine dropdown mounts this on open). */
  pollMs?: number;
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

/**
 * Stacked live view of the physical memory pool backing local inference.
 *
 * macOS reports Gezel's observed physical footprint (including Metal-backed
 * allocations) separately from the engine broker's capacity reservation.
 * Platforms without portable per-process accelerator accounting retain the
 * reservation estimate. Aggregate used/free figures come from the OS on
 * UMA/CPU hosts and the GPU driver on discrete cards. macOS file cache stays
 * separate because it is reclaimable capacity, not "Other" app use.
 */
export function MachineMemoryStrip({ pollMs = 1_000 }: Props) {
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
  const usedSummary =
    usage.usedBytes === null
      ? `${formatBytes(usage.totalBytes)} total`
      : `${formatBytes(usage.usedBytes)} of ${formatBytes(usage.totalBytes)} used`;
  const observed = typeof usage.gezelBytesObserved === 'number';
  const gezelBytes = usage.gezelBytesObserved ?? usage.gezelBytesEstimated;
  const otherPercent = usage.otherBytes === null ? 0 : percent(usage.otherBytes, usage.totalBytes);
  const cachedBytes = typeof usage.cachedBytes === 'number' ? usage.cachedBytes : null;
  const cachedPercent = cachedBytes === null ? 0 : percent(cachedBytes, usage.totalBytes);
  const gezelSegments = [
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
  ] as const;
  const ariaSummary = [
    `${label}: ${usedSummary}`,
    observed
      ? `Gezel observed footprint ${formatBytes(gezelBytes)}`
      : `Gezel estimated ${formatBytes(gezelBytes)}`,
    ...gezelSegments.map((segment) => `${segment.label} about ${formatBytes(segment.bytes)}`),
    observed && usage.engineReservedBytes > 0
      ? `models reserve about ${formatBytes(usage.engineReservedBytes)}`
      : null,
    usage.orphanedGezelEngineProcessCount > 0
      ? `${usage.orphanedGezelEngineProcessCount} leftover Gezel engine ${
          usage.orphanedGezelEngineProcessCount === 1 ? 'process' : 'processes'
        } from an earlier service session`
      : null,
    usage.otherBytes === null ? null : `other use ${formatBytes(usage.otherBytes)}`,
    cachedBytes === null ? null : `cached files ${formatBytes(cachedBytes)}, available to apps`,
    usage.freeBytes === null ? null : `free ${formatBytes(usage.freeBytes)}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="machine-memory-strip">
      <div className="machine-memory-heading">
        <span>
          {label}
          {usage.kind === 'ram' && <span className="machine-memory-context"> · CPU inference</span>}
        </span>
        <span>{usedSummary}</span>
      </div>
      <Tooltip.Provider delayDuration={150}>
        <div
          className={`machine-memory-bar${usage.usedBytes === null ? ' machine-memory-bar-unknown' : ''}`}
          role="img"
          aria-label={ariaSummary}
        >
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
      <div className="machine-memory-legend">
        <span>
          <i className="machine-memory-swatch machine-memory-swatch-gezel" aria-hidden />
          Gezel {observed ? '' : '~'}
          {formatBytes(gezelBytes)}
        </span>
        {usage.otherBytes !== null && (
          <span>
            <i className="machine-memory-swatch machine-memory-swatch-other" aria-hidden />
            Other {formatBytes(usage.otherBytes)}
          </span>
        )}
        {cachedBytes !== null && (
          <span title="Reclaimable file cache available to apps">
            <i className="machine-memory-swatch machine-memory-swatch-cached" aria-hidden />
            Cached {formatBytes(cachedBytes)}
          </span>
        )}
        {usage.freeBytes !== null && (
          <span>
            <i className="machine-memory-swatch machine-memory-swatch-free" aria-hidden />
            Free {formatBytes(usage.freeBytes)}
          </span>
        )}
      </div>
      {observed && usage.engineReservedBytes > 0 && (
        <div className="machine-memory-note">
          Models reserve ~{formatBytes(usage.engineReservedBytes)} for capacity planning
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
