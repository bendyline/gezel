import type {
  GalleryFilter,
  GalleryGroup,
  GalleryItem,
  GalleryResponse,
  GalleryShelf,
} from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../api.js';
import { KeyChoice, type KeyOption } from '../KeyChoice.js';
import type { ProjectViewProps } from '../types.js';
import { GalleryCard } from './GalleryCard.js';
import { readGalleryGroup, writeGalleryGroup } from './gallery-memory.js';
import '../../../styles/gallery-view.css';

const SHELF_PAGE = 12;
const ITEM_PAGE = 24;
const SEARCH_DELAY_MS = 250;

const GROUP_LABEL: Record<GalleryGroup, KeyOption<GalleryGroup>> = {
  event: { value: 'event', label: 'Outings', title: 'Photos by the day they were taken' },
  folder: { value: 'folder', label: 'Folders', title: 'Files by where they live' },
  type: { value: 'type', label: 'Types', title: 'Files by what they are' },
};

const FILTERS: readonly KeyOption<GalleryFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'photos', label: 'Photos', title: 'Photos, screenshots and pictures' },
  { value: 'documents', label: 'Documents', title: 'Documents, slides, PDFs and notes' },
  { value: 'data', label: 'Data', title: 'Spreadsheets, tables and data files' },
  { value: 'media', label: 'Media', title: 'Recordings and videos' },
  { value: 'code', label: 'Code', title: 'Code, tests and settings' },
];

/**
 * The Gallery view: the project's files as shelves of cards, grouped by type,
 * by folder, or — in a photo library — by outing, with exact copies and
 * look-alikes first. Everything comes from the index; no file is opened. A
 * card selects its file in the shared inspector.
 */
export default function GalleryProjectView({
  projectId,
  selectedPath,
  onSelectPath,
  setInspectorExtras,
}: ProjectViewProps) {
  const [group, setGroup] = useState<GalleryGroup | undefined>(() => readGalleryGroup(projectId));
  const [filter, setFilter] = useState<GalleryFilter>('all');
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [shelfLimit, setShelfLimit] = useState(SHELF_PAGE);
  const [data, setData] = useState<GalleryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Pages fetched by "Show more", for the query they were fetched under.
  const [more, setMore] = useState<{ query: string; pages: Record<string, GalleryItem[]> }>({
    query: '',
    pages: {},
  });
  const [loadingShelf, setLoadingShelf] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setInspectorExtras(null);
    return () => setInspectorExtras(null);
  }, [setInspectorExtras]);

  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .getGallery(projectId, {
        ...(group ? { group } : {}),
        filter,
        ...(q ? { q } : {}),
        shelves: shelfLimit,
        perShelf: ITEM_PAGE,
      })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, group, filter, q, shelfLimit]);

  // A file chosen in another view: bring its card into sight when it is on a shelf.
  useEffect(() => {
    if (!selectedPath || !body.current) return;
    for (const card of body.current.querySelectorAll<HTMLElement>('[data-path]')) {
      if (card.dataset.path === selectedPath) {
        card.scrollIntoView?.({ block: 'nearest' });
        break;
      }
    }
  }, [selectedPath]);

  const queryKey = JSON.stringify([projectId, data?.group ?? '', filter, q]);

  const chooseGroup = (next: GalleryGroup) => {
    setGroup(next);
    setShelfLimit(SHELF_PAGE);
    writeGalleryGroup(projectId, next);
  };

  const showMore = async (shelf: GalleryShelf, shown: number) => {
    if (!data) return;
    setLoadingShelf(shelf.id);
    try {
      const page = await api.getGalleryShelf(projectId, {
        group: data.group,
        filter,
        ...(q ? { q } : {}),
        shelf: shelf.id,
        offset: shown,
        limit: ITEM_PAGE,
      });
      if (page) {
        setMore((m) => {
          const pages = m.query === queryKey ? m.pages : {};
          return {
            query: queryKey,
            pages: { ...pages, [shelf.id]: [...(pages[shelf.id] ?? []), ...page.items] },
          };
        });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingShelf(null);
    }
  };

  const pages = more.query === queryKey ? more.pages : {};
  const families = data?.families ?? {};
  const filters = FILTERS.filter(
    (f) => f.value === 'all' || f.value === filter || (families[f.value] ?? 0) > 0,
  );
  const groups = (data?.groups ?? []).map((g) => GROUP_LABEL[g]);

  return (
    <section className="gallery-view">
      <header className="gallery-view-toolbar">
        {groups.length > 1 && data && (
          <KeyChoice label="Group by" value={data.group} options={groups} onChange={chooseGroup} />
        )}
        {filters.length > 2 && (
          <KeyChoice label="Show" value={filter} options={filters} onChange={setFilter} />
        )}
        <input
          type="search"
          className="gallery-view-search"
          placeholder="Find in the gallery"
          aria-label="Find in the gallery"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {data?.indexed && (
          <span className="gallery-view-total">
            {data.total.toLocaleString()} {data.total === 1 ? 'file' : 'files'}
          </span>
        )}
      </header>
      <div className="gallery-view-body" ref={body}>
        {error && <p className="gallery-view-empty">Couldn’t load the gallery: {error}</p>}
        {!error && data && !data.indexed && (
          <p className="gallery-view-empty">
            Gezel hasn’t looked through this folder yet. The gallery fills in after the first scan.
          </p>
        )}
        {!error && data?.indexed && data.total === 0 && (
          <p className="gallery-view-empty">
            {q ? `Nothing matches “${q}”.` : 'No files to show here.'}
          </p>
        )}
        {data?.shelves.map((shelf) => {
          const items = [...shelf.items, ...(pages[shelf.id] ?? [])];
          const photos = items.length > 0 && items.every((i) => i.family === 'photos');
          const left = shelf.count - items.length;
          return (
            <section key={shelf.id} className="gallery-shelf" aria-label={shelf.label}>
              <header className="gallery-shelf-header">
                <h3>{shelf.label}</h3>
                <span className="gallery-shelf-count">{shelf.count.toLocaleString()}</span>
                {shelf.description && (
                  <p className="gallery-shelf-description">{shelf.description}</p>
                )}
              </header>
              <ul className={photos ? 'gallery-grid gallery-grid--photos' : 'gallery-grid'}>
                {items.map((item) => (
                  <li key={item.path}>
                    <GalleryCard
                      projectId={projectId}
                      item={item}
                      selected={item.path === selectedPath}
                      onSelect={(path) => onSelectPath(path)}
                    />
                  </li>
                ))}
              </ul>
              {left > 0 && (
                <button
                  type="button"
                  className="secondary small"
                  disabled={loadingShelf === shelf.id}
                  onClick={() => void showMore(shelf, items.length)}
                >
                  Show {Math.min(ITEM_PAGE, left).toLocaleString()} more
                </button>
              )}
            </section>
          );
        })}
        {data && data.shelfCount > data.shelves.length && (
          <button
            type="button"
            className="secondary"
            onClick={() => setShelfLimit((n) => n + SHELF_PAGE)}
          >
            Show more groups
          </button>
        )}
      </div>
    </section>
  );
}
