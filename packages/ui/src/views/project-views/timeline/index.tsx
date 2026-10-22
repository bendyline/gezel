import type {
  TimelineBucketResponse,
  TimelineBucketSize,
  TimelineResponse,
} from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../api.js';
import { KeyChoice } from '../KeyChoice.js';
import type { ProjectViewProps } from '../types.js';
import { TimelineChart, laneColor } from './TimelineChart.js';
import { TimelineDetail } from './TimelineDetail.js';
import '../../../styles/gallery-view.css';
import '../../../styles/timeline-view.css';

const SIZES = [
  { value: 'week' as const, label: 'Weeks' },
  { value: 'month' as const, label: 'Months' },
  { value: 'year' as const, label: 'Years' },
];

const storageKey = (projectId: string) => `gezel.timeline.bucket.${projectId}`;

function readSize(projectId: string): TimelineBucketSize | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    return raw === 'week' || raw === 'month' || raw === 'year' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function writeSize(projectId: string, size: TimelineBucketSize): void {
  try {
    window.localStorage.setItem(storageKey(projectId), size);
  } catch {
    // Storage can be unavailable (private window, blocked site data).
  }
}

/**
 * The Timeline view: what changed when. A git repository shows its commits,
 * stacked by area of the project; any other folder shows its files at their
 * own dates (a photo when it was taken), stacked by kind. Choosing a stretch
 * lists what happened in it, and a file opens in the shared inspector.
 */
export default function TimelineProjectView({
  projectId,
  selectedPath,
  onSelectPath,
  setInspectorExtras,
}: ProjectViewProps) {
  const [size, setSize] = useState<TimelineBucketSize | undefined>(() => readSize(projectId));
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<TimelineBucketResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const cache = useRef(new Map<string, TimelineBucketResponse>());

  useEffect(() => {
    setInspectorExtras(null);
    return () => setInspectorExtras(null);
  }, [setInspectorExtras]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .getTimeline(projectId, size ? { bucket: size } : {})
      .then((res) => {
        if (cancelled) return;
        setData(res);
        cache.current.clear();
        let latest = res.buckets.length - 1;
        while (latest > 0 && (res.buckets[latest]?.files ?? 0) === 0) latest--;
        setSelected(res.buckets.length > 0 ? latest : null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, size]);

  const bucket = data && selected !== null ? data.buckets[selected] : undefined;

  useEffect(() => {
    if (!data || !bucket) return;
    const key = `${bucket.start}:${bucket.end}`;
    const cached = cache.current.get(key);
    setDetailError(null);
    if (cached) {
      setDetail(cached);
      return;
    }
    setDetail(null);
    let cancelled = false;
    api
      .getTimelineBucket(projectId, { start: bucket.start, end: bucket.end, source: data.source })
      .then((res) => {
        if (cancelled || !res) return;
        cache.current.set(key, res);
        setDetail(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setDetailError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, data, bucket]);

  const chooseSize = (next: TimelineBucketSize) => {
    setSize(next);
    writeSize(projectId, next);
  };

  return (
    <section className="timeline-view">
      <header className="timeline-view-toolbar">
        {data?.indexed && data.buckets.length > 0 && (
          <KeyChoice label="Bars" value={data.bucket} options={SIZES} onChange={chooseSize} />
        )}
        {data?.indexed && data.buckets.length > 0 && (
          <span className="timeline-view-source">
            {data.source === 'git' ? 'From the project’s commits' : 'From each file’s date'}
          </span>
        )}
      </header>
      <div className="timeline-view-body">
        {error && <p className="timeline-view-empty">Couldn’t load the timeline: {error}</p>}
        {!error && data && !data.indexed && (
          <p className="timeline-view-empty">
            Gezel hasn’t looked through this folder yet. The timeline fills in after the first scan.
          </p>
        )}
        {!error && data?.indexed && data.buckets.length === 0 && (
          <p className="timeline-view-empty">Nothing here has a date yet.</p>
        )}
        {data && data.buckets.length > 0 && selected !== null && (
          <>
            <TimelineChart
              buckets={data.buckets}
              lanes={data.lanes}
              size={data.bucket}
              source={data.source}
              selected={selected}
              onSelect={setSelected}
            />
            <ul className="timeline-legend" aria-label="What the colors mean">
              {data.lanes.map((lane, i) => (
                <li key={lane.id}>
                  <span
                    className="timeline-legend-swatch"
                    style={{ background: laneColor(i, lane) }}
                    aria-hidden="true"
                  />
                  {lane.label}
                </li>
              ))}
            </ul>
            {data.truncated && (
              <p className="timeline-view-note">
                The history goes back further; longer bars show all of it.
              </p>
            )}
            {bucket && (
              <TimelineDetail
                projectId={projectId}
                bucket={bucket}
                detail={detail}
                error={detailError}
                selectedPath={selectedPath}
                onSelectPath={(path) => onSelectPath(path)}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}
