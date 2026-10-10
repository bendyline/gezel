import {
  FOLDER_KIND_PROPERTY,
  type NightShiftReviewResponse,
  type NightShiftTasksResponse,
  type OnThisDayResponse,
  type PhotoAlbumSummary,
  type Question,
} from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { PendingQuestionCard } from '../../components/PendingQuestionCard.js';
import { OnThisDayRows, PhotoAlbumCards } from '../../components/PhotoAlbums.js';
import { navigateToTab } from '../../components/nav-actions.js';
import { NightPrimaryReport } from './NightReviewPanel.js';

/**
 * The Night shift tab with an unanswered review: decisions first. The card leads (what
 * is waiting on a decision, what is new, what finished, a paused review to
 * resume, and why a quiet night was quiet), then the night's main report
 * if the card does not already display it, then what is queued for tonight.
 */
export function MorningPanel({
  question,
  review,
  onAnswered,
}: {
  question: Question | null;
  review: NightShiftReviewResponse | null;
  onAnswered?: (q: Question) => void;
}) {
  const primary = review?.reports[0];
  const primaryInCard =
    primary && question?.documentPath === `projects/${primary.projectId}/artifacts/${primary.path}`;
  const [tonight, setTonight] = useState<NightShiftTasksResponse['upcoming']>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .getNightShiftTasks()
      .then((res) => {
        if (!cancelled) setTonight(res.upcoming);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="home-workshop-status-report" data-testid="morning-panel">
      {question && <PendingQuestionCard question={question} onAnswered={onAnswered} compact />}
      {!primaryInCard && <NightPrimaryReport primary={primary} />}
      <MorningPhotos />
      {tonight.length > 0 && (
        <div className="home-workshop-night-reports">
          <div className="home-workshop-eyebrow">Queued for tonight</div>
          {tonight.map((task) => (
            <button
              key={task.ref}
              type="button"
              className="home-workshop-night-report-row"
              onClick={() => navigateToTab({ kind: 'task', ref: task.ref })}
            >
              <span className="home-workshop-night-report-title">{task.title}</span>
              <span className="muted small">
                {task.projectName}
                {task.quotaHeld ? ' · waiting on your quota' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Albums proposed within this window count as last night's. */
const NEW_ALBUM_MS = 24 * 60 * 60_000;
/** Photo folders the morning reads; a person with more opens them from Projects. */
const MAX_PHOTO_FOLDERS = 4;

interface FolderPhotos {
  projectId: string;
  name: string;
  albums: PhotoAlbumSummary[];
  onThisDay: OnThisDayResponse | null;
}

/**
 * The photo folders' share of the morning: albums the crew proposed last
 * night, and photos from this day in earlier years. Read from the index, so
 * it shows even after a night with no model.
 */
function MorningPhotos() {
  const [folders, setFolders] = useState<FolderPhotos[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<FolderPhotos[]> => {
      const { projects } = await api.listProjects();
      const photoFolders = projects
        .filter((p) => p.properties?.[FOLDER_KIND_PROPERTY] === 'pictures' && !p.archived)
        .slice(0, MAX_PHOTO_FOLDERS);
      const since = Date.now() - NEW_ALBUM_MS;
      const loaded = await Promise.all(
        photoFolders.map(async (p): Promise<FolderPhotos> => {
          const [albums, onThisDay] = await Promise.all([
            api.listPhotoAlbums(p.id).catch(() => [] as PhotoAlbumSummary[]),
            api.getOnThisDay(p.id).catch(() => null),
          ]);
          return {
            projectId: p.id,
            name: p.name,
            albums: albums.filter((a) => a.updatedAt && Date.parse(a.updatedAt) >= since),
            onThisDay: onThisDay && onThisDay.years.length > 0 ? onThisDay : null,
          };
        }),
      );
      return loaded.filter((f) => f.albums.length > 0 || f.onThisDay !== null);
    };
    load()
      .then((loaded) => {
        if (!cancelled) setFolders(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (folders.length === 0) return null;
  const many = folders.length > 1;
  return (
    <>
      {folders.map((f) => (
        <div key={f.projectId} className="home-workshop-night-reports" data-testid="morning-photos">
          {f.albums.length > 0 && (
            <>
              <div className="home-workshop-eyebrow">New albums{many ? ` · ${f.name}` : ''}</div>
              <PhotoAlbumCards projectId={f.projectId} albums={f.albums} />
            </>
          )}
          {f.onThisDay && (
            <>
              <div className="home-workshop-eyebrow">On this day{many ? ` · ${f.name}` : ''}</div>
              <OnThisDayRows projectId={f.projectId} onThisDay={f.onThisDay} />
            </>
          )}
        </div>
      ))}
    </>
  );
}
