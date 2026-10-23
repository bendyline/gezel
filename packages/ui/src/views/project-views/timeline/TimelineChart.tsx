import type { TimelineBucket, TimelineBucketSize, TimelineLane } from '@bendyline/gezel';
import { type KeyboardEvent, useEffect, useRef } from 'react';

/** Lane colors, in lane order; the last lane ("Everything else") is muted. */
export const LANE_COLORS = 8;

export function laneColor(index: number, lane: TimelineLane): string {
  return lane.id === 'other'
    ? 'var(--timeline-lane-other)'
    : `var(--timeline-lane-${index % LANE_COLORS})`;
}

/** A tick under a bar where a new month (weeks), year (months) or any year begins. */
function tick(
  bucket: TimelineBucket,
  previous: TimelineBucket | undefined,
  size: TimelineBucketSize,
) {
  const [y, m] = bucket.start.split('-').map(Number) as [number, number];
  const month = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
  if (size === 'year') return String(y);
  const [py, pm] = previous ? (previous.start.split('-').map(Number) as [number, number]) : [0, 0];
  if (!previous || py !== y) return `${month} ${y}`;
  if (size === 'month') return m % 3 === 1 ? month : '';
  return pm !== m ? month : '';
}

/**
 * Activity over time: one column per bucket, its bar stacked by lane. A
 * column is a button that selects its stretch; the arrow keys move along
 * the axis. The chart opens scrolled to the newest bucket.
 */
export function TimelineChart({
  buckets,
  lanes,
  size,
  source,
  selected,
  onSelect,
}: {
  buckets: readonly TimelineBucket[];
  lanes: readonly TimelineLane[];
  size: TimelineBucketSize;
  source: 'git' | 'files';
  selected: number;
  onSelect: (index: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const bars = useRef<(HTMLButtonElement | null)[]>([]);
  const peak = Math.max(
    1,
    ...buckets.map((b) => Object.values(b.lanes).reduce((n, c) => n + c, 0)),
  );

  // Open on the newest bucket whenever the axis is rebuilt.
  const count = buckets.length;
  useEffect(() => {
    const el = scroller.current;
    if (el && count > 0) el.scrollLeft = el.scrollWidth;
  }, [count]);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft'
        ? selected - 1
        : event.key === 'ArrowRight'
          ? selected + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buckets.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(buckets.length - 1, next));
    onSelect(index);
    bars.current[index]?.focus();
  };

  return (
    <div className="timeline-chart" ref={scroller}>
      <div
        className="timeline-chart-axis"
        role="toolbar"
        aria-label="Activity over time"
        onKeyDown={move}
      >
        {buckets.map((bucket, i) => {
          const total = Object.values(bucket.lanes).reduce((n, c) => n + c, 0);
          const what =
            source === 'git'
              ? `${bucket.commits} ${bucket.commits === 1 ? 'commit' : 'commits'}, ${bucket.files} ${bucket.files === 1 ? 'file' : 'files'}`
              : `${bucket.files} ${bucket.files === 1 ? 'file' : 'files'}`;
          const label = tick(bucket, buckets[i - 1], size);
          return (
            <div key={bucket.start} className="timeline-column">
              <button
                ref={(el) => {
                  bars.current[i] = el;
                }}
                type="button"
                className="timeline-bar"
                aria-current={i === selected ? 'true' : undefined}
                aria-label={`${bucket.label}: ${what}`}
                title={`${bucket.label}\n${what}`}
                tabIndex={i === selected ? 0 : -1}
                onClick={() => onSelect(i)}
              >
                <span className="timeline-bar-stack" style={{ height: `${(total / peak) * 100}%` }}>
                  {lanes.map((lane, li) => {
                    const n = bucket.lanes[lane.id] ?? 0;
                    return n > 0 ? (
                      <span
                        key={lane.id}
                        className="timeline-bar-segment"
                        style={{ flexGrow: n, background: laneColor(li, lane) }}
                      />
                    ) : null;
                  })}
                </span>
              </button>
              <span className="timeline-tick" aria-hidden="true">
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
