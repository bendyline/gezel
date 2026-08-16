import type {
  HistoryEntry,
  MapRepoResponse,
  ProjectDetail,
  WorkspaceIndexStatus,
} from '@bendyline/gezel';
import { getProjectType, resolveProjectTypeId } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { MarkdownField } from '../components/MarkdownField.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { RailSection } from './home/RailSection.js';

/**
 * The project's gestalt page — everything the boekwachter has learned,
 * in one glance: the deep-pass architecture note, folder purposes,
 * languages, entry points, recent activity, and the latest weekly digest.
 * Every section is index-derived and appears as the index deepens; a
 * fresh project shows an honest "still being studied" state instead.
 */

interface DigestPreview {
  path: string;
  content: string;
}

const noop = () => undefined;

function latestDigestPath(files: Array<{ path: string; isDirectory: boolean }>): string | null {
  const digests = files
    .filter((f) => !f.isDirectory && /^reports\/digest-\d{4}-W\d{2}\.md$/.test(f.path))
    .map((f) => f.path)
    .sort();
  return digests[digests.length - 1] ?? null;
}

export function ProjectOverviewView({
  projectId,
  project,
}: {
  projectId: string;
  project: ProjectDetail;
}) {
  const [map, setMap] = useState<MapRepoResponse | null>(null);
  const [indexStatus, setIndexStatus] = useState<WorkspaceIndexStatus | null>(null);
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  const [digest, setDigest] = useState<DigestPreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMap(null);
    setDigest(null);
    api
      .toolMapRepo(projectId, {})
      .then((m) => {
        if (!cancelled) setMap(m);
      })
      .catch(() => {
        if (!cancelled) setMap(null);
      });
    api
      .getProjectIndexStatus(projectId)
      .then((s) => {
        if (!cancelled) setIndexStatus(s);
      })
      .catch(() => undefined);
    api
      .listHistory({ projectId, limit: 8 })
      .then((r) => {
        if (!cancelled) setRecent(r.entries);
      })
      .catch(() => undefined);
    api
      .listProjectArtifacts(projectId, 'reports', true)
      .then(async (r) => {
        const path = latestDigestPath(r.files);
        if (!path || cancelled) return;
        const file = await api.readProjectArtifact(projectId, path);
        if (!cancelled) setDigest({ path, content: file.content });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const typeId = resolveProjectTypeId(project);
  const typeName = typeId ? (getProjectType(typeId)?.label ?? typeId) : null;
  const areasWithPurpose = (map?.areas ?? []).filter((a) => a.purpose);
  const scanning = indexStatus?.state === 'indexing';
  const indexingDisabled = indexStatus?.state === 'disabled';
  const aiPending = indexStatus?.aiScanPending === true;
  const reviewPending = indexStatus?.enrichment?.reviews?.pending ?? 0;

  return (
    <div className="project-overview">
      <div className="project-overview-head">
        <div className="project-overview-title">
          <ProjectIcon project={project} size={24} className="project-overview-icon" />
          <h2>{project.name}</h2>
        </div>
        <div className="project-overview-meta">
          {typeName && <span className="project-overview-chip">{typeName}</span>}
          {map?.indexed && (
            <span className="project-overview-chip muted">{map.fileCount} files indexed</span>
          )}
          {(scanning || aiPending) && (
            <span className="project-overview-chip pending">
              {scanning ? 'scanning…' : 'AI study in progress…'}
            </span>
          )}
        </div>
      </div>

      {!map?.indexed && indexingDisabled && (
        <p className="muted">
          Workspace indexing is off for this project. You can turn it on in Project Settings.
        </p>
      )}

      {!map?.indexed && !indexingDisabled && (
        <p className="muted">
          The boekwachter hasn't scanned this workspace yet. The map, folder notes, and architecture
          summary appear here once indexing runs.
        </p>
      )}

      {map?.architecture && (
        <RailSection label="Architecture" testId="overview-architecture">
          <p className="project-overview-architecture">{map.architecture}</p>
        </RailSection>
      )}
      {map?.indexed && !map.architecture && (
        <RailSection label="Architecture">
          <p className="muted small">
            Not written yet — the boekwachter distills an architecture note after it has summarized
            the files (idle time or Night Shift).
          </p>
        </RailSection>
      )}

      {map?.health && (
        <RailSection label="Health" testId="overview-health">
          <div className="project-overview-chips">
            <span className="project-overview-chip">avg {map.health.avgHealth}/10</span>
            <span className="project-overview-chip muted">
              {map.health.reviewedFiles}/{map.health.eligibleFiles} files reviewed
            </span>
            {map.health.majorIssues > 0 && (
              <span className="project-overview-chip pending">
                {map.health.majorIssues} major issue{map.health.majorIssues === 1 ? '' : 's'}
              </span>
            )}
            {map.health.minorIssues > 0 && (
              <span className="project-overview-chip muted">{map.health.minorIssues} minor</span>
            )}
          </div>
          {reviewPending > 0 && (
            <p className="muted small">
              The boekwachter is still reviewing — {reviewPending} file
              {reviewPending === 1 ? '' : 's'} to go. Scores are its opinion, not a verdict.
            </p>
          )}
          {map.health.worstFiles.length > 0 && (
            <ul className="project-overview-areas">
              {map.health.worstFiles.map((w) => (
                <li key={w.path}>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('gezel:open-file', {
                          detail: { projectId, path: w.path, source: 'workspace' },
                        }),
                      )
                    }
                  >
                    <code>{w.path}</code>
                  </button>
                  <span className="muted small"> {w.health}/10</span>
                  {w.reason && <div className="muted small">{w.reason}</div>}
                </li>
              ))}
            </ul>
          )}
        </RailSection>
      )}

      {areasWithPurpose.length > 0 && (
        <RailSection label="Areas" testId="overview-areas">
          <ul className="project-overview-areas">
            {areasWithPurpose.slice(0, 10).map((a) => (
              <li key={a.path}>
                <code>{a.path === '.' ? '(root)' : `${a.path}/`}</code>
                <span className="muted small"> {a.fileCount} files</span>
                <div>{a.purpose}</div>
              </li>
            ))}
          </ul>
        </RailSection>
      )}

      {map && (map.languages.length > 0 || map.entryPoints.length > 0) && (
        <RailSection label="Shape">
          {map.languages.length > 0 && (
            <div className="project-overview-chips">
              {map.languages.slice(0, 8).map((l) => (
                <span key={l.lang} className="project-overview-chip muted">
                  {l.lang} · {l.fileCount}
                </span>
              ))}
            </div>
          )}
          {map.entryPoints.length > 0 && (
            <p className="small">
              Entry points:{' '}
              {map.entryPoints.slice(0, 6).map((p, i) => (
                <span key={p}>
                  {i > 0 && ', '}
                  <code>{p}</code>
                </span>
              ))}
            </p>
          )}
        </RailSection>
      )}

      {recent.length > 0 && (
        <RailSection label="Recent activity" testId="overview-activity">
          <ul className="project-overview-activity">
            {recent.map((e) => (
              <li key={e.id}>
                <span className="muted small">
                  {(e.entryType === 'event' ? e.at : e.lastActivityAt).slice(0, 10)}
                </span>{' '}
                {e.entryType === 'event' ? e.summary : `Chat: ${e.title}`}
              </li>
            ))}
          </ul>
        </RailSection>
      )}

      {digest && (
        <RailSection label="Latest weekly digest" hint={digest.path}>
          <div className="project-overview-digest">
            <MarkdownField key={digest.path} value={digest.content} readOnly onCommit={noop} />
          </div>
          <button
            type="button"
            className="project-overview-open-digest"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('gezel:open-file', {
                  detail: { projectId, path: digest.path, source: 'artifacts' },
                }),
              )
            }
          >
            Open in artifacts
          </button>
        </RailSection>
      )}
    </div>
  );
}
