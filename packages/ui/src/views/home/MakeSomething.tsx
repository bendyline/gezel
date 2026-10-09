import {
  type GezelSummary,
  type Project,
  planDisplayName,
  planOutputSummary,
  starterCraftbookIds,
  visibleCatalogItems,
} from '@bendyline/gezel';
import { Suspense, lazy, useEffect, useReducer, useState } from 'react';
import { api } from '../../api.js';
import { CatalogArtwork } from '../../components/CatalogArtwork.js';
import { navigateToTab } from '../../components/nav-actions.js';
import { useShowWorkInProgressFeatures } from '../../components/useShowWorkInProgressFeatures.js';
import { ProjectGlyph } from '../projects/new-project-meta.js';
import { type BookItem, craftbookGlyph, toBookItems } from '../tasks/new-task-meta.js';
import './make-something.css';

const NewTaskDialog = lazy(() =>
  import('../tasks/NewTaskDialog.js').then((module) => ({ default: module.NewTaskDialog })),
);

/** A first request uses the same project offer and launch form as Tasks. */
export function MakeSomething({ projectId, projects }: { projectId: string; projects: Project[] }) {
  const [books, setBooks] = useState<BookItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [retry, retryLoad] = useReducer((value: number) => value + 1, 0);
  const [selection, setSelection] = useState<string | null | undefined>(undefined);
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const showWorkInProgressFeatures = useShowWorkInProgressFeatures();
  useEffect(() => {
    // A retry remounts the request lifecycle, including its cancellation guard.
    void retry;
    let canceled = false;
    setBooks([]);
    setFailed(false);
    void api
      .listProjectCraftbooks(projectId)
      .then((result) => {
        if (canceled) return;
        const items = toBookItems(
          visibleCatalogItems(result.items ?? [], showWorkInProgressFeatures),
        );
        const ids = result.starterIds ?? starterCraftbookIds(items.map((book) => book.manifest));
        setBooks(
          ids.flatMap((id) => items.find((book) => book.manifest.id === id) ?? []).slice(0, 8),
        );
      })
      .catch(() => {
        if (!canceled) setFailed(true);
      });
    return () => {
      canceled = true;
    };
  }, [projectId, showWorkInProgressFeatures, retry]);
  useEffect(() => {
    if (selection === undefined) return;
    let canceled = false;
    void api
      .listGezels()
      .then((result) => {
        if (!canceled) setGezels(result.gezels ?? []);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [selection]);

  return (
    <section className="home-make" aria-label="Make something">
      <div className="home-make-heading">
        <h2>Make something</h2>
        <button type="button" onClick={() => setSelection(null)}>
          See all
        </button>
      </div>
      {failed ? (
        <output>
          Plans couldn’t be loaded.{' '}
          <button type="button" onClick={retryLoad}>
            Try again
          </button>
        </output>
      ) : (
        <div className="home-make-tray">
          {books.map((book) => (
            <button
              type="button"
              key={book.manifest.id}
              className="home-make-card"
              onClick={() => setSelection(book.manifest.id)}
            >
              <span className="home-make-art" aria-hidden="true">
                <CatalogArtwork
                  iconSvg={book.item.iconSvg}
                  logoUrl={book.item.logoUrl}
                  fallback={<ProjectGlyph glyph={craftbookGlyph(book.manifest)} size={28} />}
                />
              </span>
              <span className="home-make-name">{planDisplayName(book.manifest)}</span>
              <span className="home-make-description">
                {planOutputSummary(book.manifest) ?? book.manifest.description}
              </span>
            </button>
          ))}
        </div>
      )}
      {selection !== undefined && (
        <Suspense fallback={<output>Opening plan…</output>}>
          <NewTaskDialog
            open
            quickLaunch={selection !== null}
            initialCraftbookId={selection ?? undefined}
            defaultProjectId={projectId}
            projects={projects}
            gezels={gezels}
            projectLocked={selection !== null}
            onClose={() => setSelection(undefined)}
            onCreated={(task) => {
              navigateToTab({ kind: 'task', ref: task.ref });
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
