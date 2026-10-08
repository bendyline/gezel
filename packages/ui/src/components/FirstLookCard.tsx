import {
  type ChatEventEnvelope,
  type FolderKind,
  type ProjectDetail,
  type ProjectIndexOverview,
  describeFolderNightWork,
  folderKindOf,
  projectNightWorkEnabled,
} from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { streamSharedAllChatEvents } from '../shared-chat-events.js';

/** Seconds a photo takes to describe on-device (ADR 0019's measured 2.1 s). */
const SECONDS_PER_PHOTO = 2.1;

function n(value: number): string {
  return value.toLocaleString();
}

function year(stamp: string | undefined): string | null {
  return stamp ? stamp.slice(0, 4) : null;
}

/**
 * The first-look line for a folder: "12,480 photos from 2009 to 2026 · about
 * 3,100 look like duplicates · 840 screenshots". Pure, for tests.
 */
export function firstLookSummary(overview: ProjectIndexOverview, kind?: FolderKind): string[] {
  const images = overview.byModality.image ?? 0;
  const documents = (overview.byModality.doc ?? 0) + (overview.byModality.text ?? 0);
  const code = overview.byModality.code ?? 0;
  const parts: string[] = [];
  if (kind === 'pictures' || (kind !== 'code' && images > documents && images > code)) {
    const from = year(overview.takenRange?.from);
    const to = year(overview.takenRange?.to);
    parts.push(
      from && to && from !== to
        ? `${n(images)} photos from ${from} to ${to}`
        : `${n(images)} ${images === 1 ? 'photo' : 'photos'}`,
    );
  } else if (kind === 'code' || code > documents) {
    parts.push(`${n(overview.files)} files, ${n(code)} of them code`);
  } else {
    parts.push(`${n(documents)} ${documents === 1 ? 'document' : 'documents'}`);
  }
  if (overview.duplicates.extraCopies > 0) {
    parts.push(`about ${n(overview.duplicates.extraCopies)} look like duplicates`);
  }
  if (overview.screenshots > 0) parts.push(`${n(overview.screenshots)} screenshots`);
  return parts;
}

/** "about 7 hours" for describing the photos, when that is worth saying. */
export function firstNightEstimate(overview: ProjectIndexOverview): string | null {
  const photos = (overview.byModality.image ?? 0) - overview.cloudOnly;
  const hours = (photos * SECONDS_PER_PHOTO) / 3600;
  if (hours < 1) return null;
  return `Describing ${n(photos)} photos takes about ${Math.round(hours)} hours on this computer. Your crew picks up where it left off each night.`;
}

/**
 * Top of a folder project's Overview, from the first scan on: what the folder
 * holds, what was left in the cloud, what the crew does with it tonight, and
 * the switch that turns its overnight work off.
 */
export function FirstLookCard({
  projectId,
  project,
  refreshKey,
}: {
  projectId: string;
  project: ProjectDetail;
  /** Changes when a scan finishes, so the counts catch up. */
  refreshKey?: unknown;
}) {
  const [overview, setOverview] = useState<ProjectIndexOverview | null>(null);
  const [overnight, setOvernight] = useState(projectNightWorkEnabled(project));
  const [saving, setSaving] = useState(false);

  const [scansEnded, setScansEnded] = useState(0);

  useEffect(() => setOvernight(projectNightWorkEnabled(project)), [project]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and scansEnded are refetch triggers.
  useEffect(() => {
    let cancelled = false;
    api
      .getProjectIndexOverview(projectId)
      .then((o) => {
        if (!cancelled) setOverview(o);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, scansEnded]);

  // The first scan of a big folder takes minutes; catch up when one ends.
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const env of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const ev = (env as ChatEventEnvelope).event;
          if (
            ev.type === 'index_progress' &&
            ev.phase === 'scan' &&
            ev.state === 'ended' &&
            ev.projectId === projectId
          ) {
            setScansEnded((v) => v + 1);
          }
        }
      } catch {
        /* stream ended */
      }
    })();
    return () => ctrl.abort();
  }, [projectId]);

  if (!project.workingDir || !overview || overview.files === 0) return null;
  const kind = folderKindOf(project);
  const estimate = overnight ? firstNightEstimate(overview) : null;
  return (
    <section className="first-look" aria-label="What's in this folder">
      <p className="first-look-summary">{firstLookSummary(overview, kind).join(' · ')}</p>
      {overview.cloudOnly > 0 && (
        <p className="first-look-note">
          {n(overview.cloudOnly)} {overview.cloudOnly === 1 ? 'file is' : 'files are'} stored only
          in the cloud. Gezel lists them by name and date and leaves them there.
        </p>
      )}
      {overnight && kind && (
        <>
          <div className="first-look-eyebrow">Tonight your crew will</div>
          <ul className="first-look-night">
            {describeFolderNightWork(kind).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {estimate && <p className="first-look-note">{estimate}</p>}
      <label className="first-look-switch">
        <input
          type="checkbox"
          checked={overnight}
          disabled={saving}
          onChange={(e) => {
            const next = e.target.checked;
            setSaving(true);
            setOvernight(next);
            api
              .setProjectNightWork(projectId, next)
              .catch(() => setOvernight(!next))
              .finally(() => setSaving(false));
          }}
        />
        <span>Work on this folder overnight</span>
      </label>
    </section>
  );
}
