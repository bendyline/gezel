import type { OnThisDayResponse, PhotoAlbumSummary } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';
import { RailSection } from '../views/home/RailSection.js';
import { PhotoGrid } from './PhotoGrid.js';
import { PhotoThumb } from './PhotoThumb.js';
import { openProjectFileActions, runNavActions } from './nav-actions.js';

/** `2026-09-20` or `2026-09-20 – 2026-09-22`, from an album's capture span. */
export function albumSpanLabel(from?: string, to?: string): string | null {
  const a = from?.slice(0, 10);
  const b = to?.slice(0, 10);
  if (!a) return null;
  return !b || a === b ? a : `${a} – ${b}`;
}

/** A folder name made from an album title: letters, numbers, spaces and dashes. */
export function albumFolderName(title: string | undefined): string {
  const clean = (title ?? 'Album')
    .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `Albums/${clean || 'Album'}`;
}

function openPhoto(projectId: string, path: string): void {
  runNavActions(openProjectFileActions({ projectId, path, source: 'workspace' }));
}

/**
 * Open an album where it plays, edits and exports: its Squisq slideshow
 * document in the project's file editor. Its photos are stored with it first,
 * so the slides are never broken images.
 */
export async function openPhotoAlbum(projectId: string, path: string): Promise<void> {
  await api.preparePhotoAlbum(projectId, path).catch(() => undefined);
  runNavActions(openProjectFileActions({ projectId, path, source: 'artifacts' }));
}

/**
 * The one thing an album writes into the folder, and only on the person's
 * click: copies of its full-size original photos in a folder they name. The
 * originals stay where they are, and nothing already there is replaced.
 */
export function CopyAlbumDialog({
  projectId,
  album,
  onClose,
}: {
  projectId: string;
  album: PhotoAlbumSummary | null;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState('');
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'copying' }
    | { kind: 'done'; text: string }
    | { kind: 'error'; text: string }
  >({ kind: 'idle' });
  useEffect(() => {
    setFolder(albumFolderName(album?.title));
    setState({ kind: 'idle' });
  }, [album]);

  const copy = async () => {
    if (!album) return;
    setState({ kind: 'copying' });
    try {
      const res = await api.copyPhotoAlbumToFolder(projectId, { path: album.path, folder });
      const skipped = res.skipped.length > 0 ? ` ${res.skipped.length} could not be copied.` : '';
      setState({
        kind: 'done',
        text: `Copied ${res.copied} photo${res.copied === 1 ? '' : 's'} into ${res.folder}.${skipped}`,
      });
    } catch (err) {
      setState({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };
  const busy = state.kind === 'copying' || state.kind === 'done';
  return (
    <Dialog.Root open={album !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="photo-album-copy-dialog" aria-describedby={undefined}>
          <Dialog.Title asChild>
            <h2>Copy “{album?.title}” to a folder</h2>
          </Dialog.Title>
          <p className="muted small">
            The full-size photos are copied into a folder inside this project. The originals stay
            where they are, and nothing already in the folder is replaced.
          </p>
          <div className="photo-album-copy-row">
            <input
              aria-label="Folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              disabled={busy}
            />
            <button type="button" onClick={() => void copy()} disabled={!folder.trim() || busy}>
              {state.kind === 'copying' ? 'Copying…' : 'Copy'}
            </button>
          </div>
          {state.kind === 'done' && <p className="muted small">{state.text}</p>}
          {state.kind === 'error' && <p className="error small">{state.text}</p>}
          <Dialog.Actions>
            <Dialog.Close asChild>
              <button type="button" className="secondary">
                {state.kind === 'done' ? 'Done' : 'Cancel'}
              </button>
            </Dialog.Close>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A row of album covers. A cover opens the album's slideshow document — play
 * it, change it, export it to video — and "Copy to a folder…" gathers its
 * original photos in one place.
 */
export function PhotoAlbumCards({
  projectId,
  albums,
}: {
  projectId: string;
  albums: PhotoAlbumSummary[];
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const [copying, setCopying] = useState<PhotoAlbumSummary | null>(null);
  return (
    <>
      <ul className="photo-album-cards">
        {albums.map((album) => (
          <li key={album.path} className="photo-album-card-item">
            <button
              type="button"
              className="photo-album-card"
              disabled={opening === album.path}
              onClick={() => {
                setOpening(album.path);
                void openPhotoAlbum(projectId, album.path).finally(() => setOpening(null));
              }}
            >
              {album.cover && (
                <PhotoThumb projectId={projectId} path={album.cover} alt={album.title} />
              )}
              <span className="photo-album-card-title">{album.title}</span>
              <span className="muted small">
                {opening === album.path
                  ? 'Opening…'
                  : `${albumSpanLabel(album.from, album.to) ?? ''}${album.from ? ' · ' : ''}${album.count} photo${album.count === 1 ? '' : 's'}`}
              </span>
            </button>
            <button
              type="button"
              className="photo-album-card-copy small"
              onClick={() => setCopying(album)}
            >
              Copy to a folder…
            </button>
          </li>
        ))}
      </ul>
      <CopyAlbumDialog projectId={projectId} album={copying} onClose={() => setCopying(null)} />
    </>
  );
}

/** Earlier years' photos from today's date, a year to a row. */
export function OnThisDayRows({
  projectId,
  onThisDay,
}: {
  projectId: string;
  onThisDay: OnThisDayResponse;
}) {
  return (
    <div className="photo-on-this-day">
      {onThisDay.years.map((y) => (
        <div key={y.year} className="photo-on-this-day-year">
          <span className="small">
            <strong>{y.year}</strong>{' '}
            <span className="muted">
              · {y.count} photo{y.count === 1 ? '' : 's'}
            </span>
          </span>
          <PhotoGrid
            projectId={projectId}
            pageSize={6}
            photos={y.paths.map((path) => ({ path }))}
            onOpen={(path) => openPhoto(projectId, path)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * A photo folder's Overview section: the album proposals the crew left, and
 * what was photographed on this day in earlier years. Renders nothing for a
 * folder with neither, so a codebase's Overview is unchanged.
 */
export function PhotoAlbumsSection({ projectId }: { projectId: string }) {
  const [albums, setAlbums] = useState<PhotoAlbumSummary[]>([]);
  const [onThisDay, setOnThisDay] = useState<OnThisDayResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAlbums([]);
    setOnThisDay(null);
    api
      .listPhotoAlbums(projectId)
      .then((a) => {
        if (!cancelled) setAlbums(a);
      })
      .catch(() => undefined);
    api
      .getOnThisDay(projectId)
      .then((d) => {
        if (!cancelled) setOnThisDay(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const memories = onThisDay && onThisDay.years.length > 0 ? onThisDay : null;
  if (albums.length === 0 && !memories) return null;
  return (
    <>
      {albums.length > 0 && (
        <RailSection label="Albums" hint={`${albums.length} proposed`} testId="overview-albums">
          <PhotoAlbumCards projectId={projectId} albums={albums} />
        </RailSection>
      )}
      {memories && (
        <RailSection label="On this day" testId="overview-on-this-day">
          <OnThisDayRows projectId={projectId} onThisDay={memories} />
        </RailSection>
      )}
    </>
  );
}
