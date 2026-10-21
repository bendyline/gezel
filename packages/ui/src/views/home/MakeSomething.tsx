import {
  type CatalogItemSummary,
  type GezelSummary,
  type Project,
  catalogGroundFor,
  interestAreasForCraftbook,
  pickWithRange,
  planDisplayName,
  planOutputSummary,
  planShortDescription,
  starterCraftbookIds,
  visibleCatalogItems,
} from '@bendyline/gezel';
import { Suspense, lazy, useEffect, useMemo, useReducer, useState } from 'react';
import { api } from '../../api.js';
import { CatalogArtwork } from '../../components/CatalogArtwork.js';
import { navigateToTab } from '../../components/nav-actions.js';
import { useInterests } from '../../components/useInterests.js';
import { useShowWorkInProgressFeatures } from '../../components/useShowWorkInProgressFeatures.js';
import { runtimeCapabilities } from '../../runtime-capabilities.js';
import { openSettingsSection } from '../../settings-nav.js';
import {
  ProjectGlyph,
  type ProjectGlyphId,
  catalogProjectTypeAreas,
  catalogProjectTypeGlyph,
} from '../projects/new-project-meta.js';
import { loadOfferedProjectTypes } from '../projects/offered-project-types.js';
import { type BookItem, craftbookGlyph, toBookItems } from '../tasks/new-task-meta.js';
import './make-something.css';

const NewTaskDialog = lazy(() =>
  import('../tasks/NewTaskDialog.js').then((module) => ({ default: module.NewTaskDialog })),
);
const NewProjectDialog = lazy(() =>
  import('../projects/NewProjectDialog.js').then((module) => ({
    default: module.NewProjectDialog,
  })),
);

/** A first request uses the same project offer and launch form as Tasks. */
export function MakeSomething({ projectId, projects }: { projectId: string; projects: Project[] }) {
  const [pool, setPool] = useState<BookItem[]>([]);
  const [starterIds, setStarterIds] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);
  const [retry, retryLoad] = useReducer((value: number) => value + 1, 0);
  const [selection, setSelection] = useState<string | null | undefined>(undefined);
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [typePool, setTypePool] = useState<CatalogItemSummary[]>([]);
  const [typeSelection, setTypeSelection] = useState<string | null | undefined>(undefined);
  const showWorkInProgressFeatures = useShowWorkInProgressFeatures();
  const interests = useInterests();
  const caps = runtimeCapabilities();
  const offersProjectTypes = caps.projects && (caps.catalog || caps.projectTypes === true);
  // The person's areas first, and one place kept for another area so a
  // single pick never makes gezel look like it does one thing.
  const books = useMemo(
    () =>
      pickWithRange(pool, (book) => interestAreasForCraftbook(book.manifest), interests.areas, 8),
    [pool, interests.areas],
  );
  const projectTypes = useMemo(
    () => pickWithRange(typePool, catalogProjectTypeAreas, interests.areas, 6),
    [typePool, interests.areas],
  );
  useEffect(() => {
    // A retry remounts the request lifecycle, including its cancellation guard.
    void retry;
    let canceled = false;
    setPool([]);
    setFailed(false);
    void api
      .listProjectCraftbooks(projectId)
      .then((result) => {
        if (canceled) return;
        // A plan this host cannot run is listed in New Task with its reason;
        // it is never one of Home's suggestions.
        const items = toBookItems(
          visibleCatalogItems(result.items ?? [], showWorkInProgressFeatures),
        ).filter((book) => !book.item.unavailableReason);
        const ids = result.starterIds ?? starterCraftbookIds(items.map((book) => book.manifest));
        const starters = ids.flatMap((id) => items.find((book) => book.manifest.id === id) ?? []);
        // First-project books join the pool so a chosen area has something
        // of its own to offer; the starters keep their order ahead of them.
        const firstProjects = items.filter(
          (book) =>
            (book.manifest.tags ?? []).includes('first-project') && !starters.includes(book),
        );
        setPool([...starters, ...firstProjects]);
        setStarterIds(new Set(starters.map((book) => book.manifest.id)));
      })
      .catch(() => {
        if (!canceled) setFailed(true);
      });
    return () => {
      canceled = true;
    };
  }, [projectId, showWorkInProgressFeatures, retry]);
  useEffect(() => {
    if (!offersProjectTypes) return;
    let canceled = false;
    // The project row is an extra shelf: when the catalog cannot answer, it
    // stays away rather than adding a second error beside the plans.
    void loadOfferedProjectTypes(showWorkInProgressFeatures)
      .then((types) => {
        if (!canceled) setTypePool(types.filter((type) => !type.unavailableReason));
      })
      .catch(() => {
        if (!canceled) setTypePool([]);
      });
    return () => {
      canceled = true;
    };
  }, [offersProjectTypes, showWorkInProgressFeatures]);
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
            <MakeSomethingCard
              key={book.manifest.id}
              item={book.item}
              name={planDisplayName(book.manifest)}
              description={
                (starterIds.has(book.manifest.id)
                  ? planOutputSummary(book.manifest, { starter: true })
                  : null) ?? planShortDescription(book.manifest.description)
              }
              glyph={craftbookGlyph(book.manifest)}
              onOpen={() => setSelection(book.manifest.id)}
            />
          ))}
        </div>
      )}
      {projectTypes.length > 0 && (
        <>
          <div className="home-make-heading home-make-subheading">
            <h3>Start a project</h3>
            <button
              type="button"
              aria-label="See all project types"
              onClick={() => setTypeSelection(null)}
            >
              See all
            </button>
          </div>
          <div className="home-make-tray">
            {projectTypes.map((item) => (
              <MakeSomethingCard
                key={item.manifest.id}
                item={item}
                name={item.manifest.name}
                description={planShortDescription(item.manifest.description)}
                glyph={catalogProjectTypeGlyph(item)}
                onOpen={() => setTypeSelection(item.manifest.id)}
              />
            ))}
          </div>
        </>
      )}
      {caps.daemonSettings && (
        <div className="home-make-footer">
          <button
            type="button"
            className="gz-link-button"
            onClick={() => openSettingsSection('connectedApps')}
          >
            Integrate Gezel into other apps…
          </button>
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
      {typeSelection !== undefined && (
        <Suspense fallback={<output>Opening project types…</output>}>
          <NewProjectDialog
            open
            mode="crew"
            {...(typeSelection ? { initialTypeId: typeSelection } : {})}
            onClose={() => setTypeSelection(undefined)}
            onCreated={(project) => {
              // Cached project reads are dropped before the new tab reads them.
              window.dispatchEvent(
                new CustomEvent('gezel:project-created', {
                  detail: { id: project.id, name: project.name },
                }),
              );
              navigateToTab({ kind: 'project', id: project.id });
            }}
          />
        </Suspense>
      )}
    </section>
  );
}

/**
 * A paper card holding the item's mark on its category ground. A starter says
 * in a few words what comes back; every other plan and project type keeps the
 * opening clause of its own description, so every key is one size.
 */
function MakeSomethingCard({
  item,
  name,
  description,
  glyph,
  onOpen,
}: {
  item: CatalogItemSummary;
  name: string;
  description: string;
  glyph: ProjectGlyphId;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="home-make-card" onClick={onOpen}>
      <span className="home-make-art" aria-hidden="true">
        <CatalogArtwork
          iconSvg={item.iconSvg}
          logoUrl={item.logoUrl}
          ground={catalogGroundFor(item.manifest)}
          fallback={<ProjectGlyph glyph={glyph} size={36} />}
        />
      </span>
      <span className="home-make-name">{name}</span>
      <span className="home-make-description">{description}</span>
    </button>
  );
}
