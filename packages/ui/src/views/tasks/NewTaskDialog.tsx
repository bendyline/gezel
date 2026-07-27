import type {
  CraftbookToolsetNeed,
  GezelSummary,
  NewCraftbookStep,
  Project,
  Task,
  TaskAssignee,
  TaskCronOverlap,
} from '@bendyline/gezel';
import type { SquisqAnnotatedSchema } from '@bendyline/squisq';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { CraftbookToolsetSetup } from '../../components/CraftbookToolsetSetup.js';
import { GezelJsonEditor } from '../../components/GezelJsonEditor.js';
import { Dialog, Select } from '../../primitives/index.js';
import { ProjectGlyph } from '../projects/new-project-meta.js';
import {
  type BookItem,
  GENERAL_TASK_CARD,
  composeCraftbookDescription,
  craftbookGlyph,
  craftbookHasParams,
  seedParamDefaults,
  stringifyParamValues,
  taskLensesFor,
  toBookItems,
} from './new-task-meta.js';

/**
 * Sentinel for "let the entry step's role decide". Sends no assignee, so
 * the service stamps whoever the role resolved into.
 */
const AUTO_ASSIGNEE = '__auto';

/**
 * Modal for creating a new task, mirroring the New Project dialog's
 * gallery layout: a category rail, a card gallery whose star section is
 * the craftbooks recommended for this project, and a right-hand pane
 * with the selected recipe's steps + the task's properties.
 *
 * Tasks land as inert drafts ("ready to fire") — creating one never
 * starts a gezel. The fire affordance lives on the task detail
 * (`TaskManager.activate` kicks off the entry step from there). The one
 * exception is a scheduled general task: cron hosts must be active to
 * tick, and their schedule — not creation — is what starts work.
 */
export function NewTaskDialog({
  open,
  defaultProjectId,
  projects,
  gezels,
  projectLocked,
  onClose,
  onCreated,
}: {
  open: boolean;
  defaultProjectId: string;
  projects: Project[];
  gezels: GezelSummary[];
  /** When true, the view is pinned to one project — hide the project picker. */
  projectLocked: boolean;
  onClose: () => void;
  onCreated: (created: Task) => Promise<void> | void;
}) {
  const [projectId, setProjectId] = useState(defaultProjectId);
  // Gallery data — re-fetched per project (applicability + suggestions
  // depend on the project's type and GitHub/branch state).
  const [books, setBooks] = useState<BookItem[]>([]);
  const [booksLoaded, setBooksLoaded] = useState(false);
  const [missingToolsets, setMissingToolsets] = useState<Record<string, CraftbookToolsetNeed[]>>(
    {},
  );
  const [projectType, setProjectType] = useState<{ id: string; label: string } | null>(null);
  const [suggestedIds, setSuggestedIds] = useState<Set<string>>(new Set());
  // Selection: null = the General (blank) card; else a craftbook id.
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeRail, setActiveRail] = useState<string>('all');
  // One-shot "land on the recommended shelf" per open/project — later
  // refetches (e.g. after a toolset install) must not yank the user off
  // a shelf they picked themselves.
  const [railInitialized, setRailInitialized] = useState(false);
  // Properties form.
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [stepNames, setStepNames] = useState('Main');
  // '' = unset (resolved to the roster default), '__user' = me, else a gezel id.
  const [assigneeSel, setAssigneeSel] = useState('');
  const [assigneeTouched, setAssigneeTouched] = useState(false);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [cron, setCron] = useState('');
  const [cronOverlap, setCronOverlap] = useState<TaskCronOverlap>('skip');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Reset per open so the dialog never reopens half-filled.
  useEffect(() => {
    if (!open) return;
    setProjectId(defaultProjectId);
    setSelectedBookId(null);
    setQuery('');
    setActiveRail('all');
    setRailInitialized(false);
    setTitle('');
    setTitleTouched(false);
    setDescription('');
    setStepNames('Main');
    setAssigneeSel('');
    setAssigneeTouched(false);
    setParams({});
    setCron('');
    setCronOverlap('skip');
    setBusy(false);
    setError('');
  }, [open, defaultProjectId]);

  const loadCraftbooks = useCallback(async () => {
    if (!projectId) {
      setBooks([]);
      setBooksLoaded(true);
      return;
    }
    try {
      const res = await api.listProjectCraftbooks(projectId);
      setBooks(toBookItems(res.items ?? []));
      setMissingToolsets(res.missingToolsets ?? {});
      setProjectType(res.projectType ?? null);
      setSuggestedIds(new Set(res.suggestedIds ?? []));
    } catch {
      // Craftbooks are best-effort — the General card always works.
      setBooks([]);
      setMissingToolsets({});
      setProjectType(null);
      setSuggestedIds(new Set());
    } finally {
      setBooksLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setBooksLoaded(false);
    void loadCraftbooks();
  }, [open, loadCraftbooks]);

  // Land on the project's recommended shelf when it has one (once per
  // open/project — user shelf picks stick after that).
  useEffect(() => {
    if (!open || !booksLoaded || railInitialized) return;
    setRailInitialized(true);
    if (suggestedIds.size > 0) setActiveRail('recommended');
  }, [open, booksLoaded, railInitialized, suggestedIds]);

  const selectedBook = selectedBookId
    ? (books.find((b) => b.manifest.id === selectedBookId) ?? null)
    : null;

  // The role the entry step names, if any. A craftbook that names one
  // picks its own owner — the role resolves to a specialist when the
  // task fires and that gezel becomes the assignee, so there is nothing
  // for the user to decide here.
  const entryRole: string | null = (() => {
    if (!selectedBook) return null;
    const m = selectedBook.manifest;
    const entry = m.steps.find((s) => s.id === m.entryStepId) ?? m.steps[0];
    return entry?.suggestedRole ?? null;
  })();

  const selectGeneral = useCallback(() => {
    setSelectedBookId(null);
    setParams({});
    setError('');
    if (!titleTouched) setTitle('');
  }, [titleTouched]);

  const selectBook = useCallback(
    (b: BookItem) => {
      setSelectedBookId(b.manifest.id);
      setParams(seedParamDefaults(b.manifest.paramSchema));
      setError('');
      if (!titleTouched) setTitle(b.manifest.name);
      if (!assigneeTouched) {
        const d = b.manifest.defaultAssignee;
        if (d?.kind === 'gezel' && gezels.some((g) => g.id === d.gezelId)) {
          setAssigneeSel(d.gezelId);
        }
      }
    },
    [titleTouched, assigneeTouched, gezels],
  );

  // An explicit pick always wins. Otherwise a role-annotated craftbook
  // defers (`null` — we send no assignee and the service mirrors the
  // entry step's resolved specialist), and everything else falls back to
  // the first gezel on the roster.
  const resolvedAssigneeSel =
    assigneeSel || (entryRole ? AUTO_ASSIGNEE : (gezels[0]?.id ?? '__user'));
  const assignee: TaskAssignee | null =
    resolvedAssigneeSel === AUTO_ASSIGNEE
      ? null
      : resolvedAssigneeSel === '__user'
        ? { kind: 'user' }
        : { kind: 'gezel', gezelId: resolvedAssigneeSel };

  const lenses = useMemo(() => taskLensesFor(books), [books]);
  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;

  const suggestedBooks = useMemo(
    () => books.filter((b) => suggestedIds.has(b.manifest.id)),
    [books, suggestedIds],
  );
  const filteredBooks = useMemo(() => {
    if (!searching) return books;
    return books.filter((b) =>
      `${b.manifest.id} ${b.manifest.name} ${b.manifest.description} ${(b.manifest.tags ?? []).join(' ')}`
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [books, searching, normalizedQuery]);
  const generalMatches =
    !searching ||
    `${GENERAL_TASK_CARD.label} ${GENERAL_TASK_CARD.description} blank fresh`
      .toLowerCase()
      .includes(normalizedQuery);

  // The gallery body under the current rail selection (search overrides).
  const gallerySections = useMemo(() => {
    if (searching) {
      return [
        {
          id: 'search',
          title: 'Craftbooks',
          tagline: `matching "${query.trim()}"`,
          books: filteredBooks,
        },
      ];
    }
    if (activeRail === 'recommended' && suggestedBooks.length > 0) {
      return [
        {
          id: 'recommended',
          title: projectType ? `Recommended for ${projectType.label}` : 'Recommended',
          tagline: 'proven recipes for this kind of project',
          books: suggestedBooks,
        },
      ];
    }
    const lens = lenses.find((l) => l.id === activeRail);
    if (lens) {
      return [
        {
          id: lens.id,
          title: lens.label,
          tagline: lens.tagline,
          books: books.filter((b) => lens.bookIds.has(b.manifest.id)),
        },
      ];
    }
    return [{ id: 'all', title: 'All craftbooks', tagline: undefined, books }];
  }, [searching, query, filteredBooks, activeRail, suggestedBooks, projectType, lenses, books]);

  const selectedNeeds: CraftbookToolsetNeed[] = selectedBook
    ? (missingToolsets[selectedBook.manifest.id] ?? [])
    : [];

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;
      setError('');
      if (!projectId) {
        setError('Pick a project.');
        return;
      }

      // CRAFTBOOK: resolved from the catalog; embedded at create time.
      if (selectedBook) {
        const m = selectedBook.manifest;
        if ((missingToolsets[m.id]?.length ?? 0) > 0) {
          setError('This craftbook needs its toolsets installed first — see the setup list.');
          return;
        }
        const schema = m.paramSchema as SquisqAnnotatedSchema | undefined;
        const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
        const missingKey = required.find((k) => {
          const v = params[k];
          return v === undefined || v === null || v === '';
        });
        if (missingKey) {
          setError(`"${missingKey}" is required.`);
          return;
        }
        const stringified = stringifyParamValues(params);
        setBusy(true);
        try {
          const created = await api.createTask(projectId, {
            title: title.trim() || m.name,
            description: composeCraftbookDescription(m, stringified),
            craftbookId: m.id,
            ...(selectedBook.item.sourceId
              ? { craftbookSourceId: selectedBook.item.sourceId }
              : {}),
            ...(assignee ? { assignee } : {}),
            status: 'draft',
            ...(Object.keys(stringified).length > 0 ? { craftbookParams: stringified } : {}),
          });
          // Stamp invocation params as an entry-step note (best-effort),
          // mirroring the terminal launcher, so the gezel reads them via
          // `read_task_notes` when the task fires.
          if (Object.keys(stringified).length > 0 && created.activeStepId) {
            const lines = ['# Invocation parameters', ''];
            for (const [k, v] of Object.entries(stringified)) lines.push(`- **${k}**: ${v}`);
            await api
              .appendTaskNote(created.projectId, created.num, {
                text: lines.join('\n'),
                stepId: created.activeStepId,
              })
              .catch(() => {});
          }
          await onCreated(created);
          onClose();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
        return;
      }

      // GENERAL: inline steps baked into an ad-hoc embedded craftbook.
      const t = title.trim();
      if (!t) {
        setError('Title is required.');
        return;
      }
      if (description.trim().length < 40) {
        setError(
          "Description must be at least 40 characters — the job-to-be-done from the user's perspective. What does success look like?",
        );
        return;
      }
      const steps: NewCraftbookStep[] = stepNames
        .split(/\n|,/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name }));
      if (steps.length === 0) steps.push({ name: 'Main' });
      const cronExpr = cron.trim();
      setBusy(true);
      try {
        const created = await api.createTask(projectId, {
          title: t,
          description: description.trim(),
          steps,
          ...(assignee ? { assignee } : {}),
          // Drafts cannot host a schedule — a cron task must be active to
          // tick, and it is the schedule (not creation) that starts work.
          ...(cronExpr
            ? { cron: { expression: cronExpr, overlap: cronOverlap } }
            : { status: 'draft' as const }),
        });
        await onCreated(created);
        onClose();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      projectId,
      selectedBook,
      missingToolsets,
      params,
      title,
      assignee,
      description,
      stepNames,
      cron,
      cronOverlap,
      onCreated,
      onClose,
    ],
  );

  const selectedSchema =
    selectedBook && craftbookHasParams(selectedBook.manifest)
      ? (selectedBook.manifest.paramSchema as SquisqAnnotatedSchema)
      : null;
  const createDisabled = busy || (selectedBook !== null && selectedNeeds.length > 0);
  const scheduled = !selectedBook && cron.trim().length > 0;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="gz-npd gz-ntd">
          <form onSubmit={handleSubmit} style={{ display: 'contents' }}>
            <header className="gz-npd-header">
              <div className="gz-npd-header-copy">
                <Dialog.Title asChild>
                  <h3>New Task</h3>
                </Dialog.Title>
                <p className="gz-npd-header-sub">
                  Pick a craftbook — a proven recipe your crew follows step by step — or start
                  blank.
                </p>
              </div>
              <label className="gz-npd-search">
                <span className="sr-only">Search craftbooks</span>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search craftbooks…"
                />
              </label>
            </header>
            <div className="gz-npd-body">
              <nav className="gz-npd-rail" aria-label="Craftbook shelves">
                {suggestedBooks.length > 0 && (
                  <button
                    type="button"
                    className={`gz-npd-rail-item${!searching && activeRail === 'recommended' ? ' active' : ''}`}
                    onClick={() => setActiveRail('recommended')}
                  >
                    <ProjectGlyph glyph="sprout" size={16} />
                    <span className="gz-npd-rail-label">Recommended</span>
                    <span className="gz-npd-rail-count">{suggestedBooks.length}</span>
                  </button>
                )}
                <button
                  type="button"
                  className={`gz-npd-rail-item${!searching && activeRail === 'all' ? ' active' : ''}`}
                  onClick={() => setActiveRail('all')}
                >
                  <ProjectGlyph glyph="sheet" size={16} />
                  <span className="gz-npd-rail-label">All craftbooks</span>
                  <span className="gz-npd-rail-count">{books.length}</span>
                </button>
                {lenses.map((lens) => (
                  <button
                    key={lens.id}
                    type="button"
                    className={`gz-npd-rail-item${!searching && activeRail === lens.id ? ' active' : ''}`}
                    onClick={() => setActiveRail(lens.id)}
                  >
                    <ProjectGlyph glyph={lens.glyph} size={16} />
                    <span className="gz-npd-rail-label">{lens.label}</span>
                    <span className="gz-npd-rail-count">{lens.bookIds.size}</span>
                  </button>
                ))}
              </nav>
              <div className="gz-npd-gallery" role="radiogroup" aria-label="Task type">
                {generalMatches && (
                  <section className="gz-npd-section">
                    <div className="gz-npd-section-head">
                      <span className="gz-npd-section-title">Start fresh</span>
                    </div>
                    <div className="gz-npd-grid">
                      <GalleryCard
                        label={GENERAL_TASK_CARD.label}
                        description={GENERAL_TASK_CARD.description}
                        glyph={GENERAL_TASK_CARD.glyph}
                        index={0}
                        active={selectedBookId === null}
                        onSelect={selectGeneral}
                      />
                    </div>
                  </section>
                )}
                {gallerySections.map((section) => (
                  <section key={section.id} className="gz-npd-section">
                    <div className="gz-npd-section-head">
                      <span className="gz-npd-section-title">{section.title}</span>
                      {section.tagline && (
                        <span className="gz-npd-section-tagline">{section.tagline}</span>
                      )}
                    </div>
                    {section.books.length > 0 ? (
                      <div className="gz-npd-grid">
                        {section.books.map((b, index) => (
                          <GalleryCard
                            key={b.manifest.id}
                            label={b.manifest.name}
                            description={b.manifest.description}
                            glyph={craftbookGlyph(b.manifest)}
                            {...(b.item.iconSvg ? { iconSvg: b.item.iconSvg } : {})}
                            {...(b.item.logoUrl ? { logoUrl: b.item.logoUrl } : {})}
                            suggested={suggestedIds.has(b.manifest.id)}
                            index={index + 1}
                            active={b.manifest.id === selectedBookId}
                            onSelect={() => selectBook(b)}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="gz-npd-empty">
                        {booksLoaded
                          ? searching
                            ? 'No craftbooks match your search.'
                            : 'No craftbooks here yet.'
                          : 'Loading craftbooks…'}
                      </p>
                    )}
                    {section.id === 'recommended' && books.length > suggestedBooks.length && (
                      <button
                        type="button"
                        className="gz-ntd-show-all"
                        onClick={() => setActiveRail('all')}
                      >
                        Browse all {books.length} craftbooks
                      </button>
                    )}
                  </section>
                ))}
              </div>
              <aside className="gz-npd-pane">
                <div className="gz-npd-pane-scroll" key={selectedBookId ?? '__general'}>
                  {selectedBook ? (
                    <div className="gz-npd-hero">
                      <div className="gz-npd-hero-art" aria-hidden="true">
                        {selectedBook.item.iconSvg ? (
                          <span
                            className="gz-npd-hero-art-svg"
                            // biome-ignore lint/security/noDangerouslySetInnerHtml: catalog icon SVGs are server-sanitized before delivery.
                            dangerouslySetInnerHTML={{ __html: selectedBook.item.iconSvg }}
                          />
                        ) : selectedBook.item.logoUrl ? (
                          <img src={selectedBook.item.logoUrl} alt="" />
                        ) : (
                          <ProjectGlyph glyph={craftbookGlyph(selectedBook.manifest)} size={34} />
                        )}
                      </div>
                      <p className="gz-npd-hero-eyebrow">
                        Craftbook
                        {suggestedIds.has(selectedBook.manifest.id) ? ' · recommended' : ''}
                      </p>
                      <h4 className="gz-npd-hero-name">{selectedBook.manifest.name}</h4>
                      <p className="gz-npd-hero-description">{selectedBook.manifest.description}</p>
                      {selectedBook.manifest.basedOn && (
                        <p className="gz-ntd-based-on">
                          Based on{' '}
                          <a
                            href={selectedBook.manifest.basedOn.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {selectedBook.manifest.basedOn.name}
                          </a>
                        </p>
                      )}
                      <div className="gz-ntd-steps">
                        <p className="gz-npd-give-eyebrow">
                          The recipe — {selectedBook.manifest.steps.length} step
                          {selectedBook.manifest.steps.length === 1 ? '' : 's'}
                        </p>
                        <ol className="gz-ntd-steps-list">
                          {selectedBook.manifest.steps.map((s) => (
                            <li key={s.id}>
                              <span className="gz-ntd-step-name">{s.name}</span>
                              {s.suggestedRole && (
                                <span className="gz-ntd-step-role">{s.suggestedRole}</span>
                              )}
                            </li>
                          ))}
                        </ol>
                      </div>
                    </div>
                  ) : (
                    <div className="gz-npd-hero">
                      <div className="gz-npd-hero-art" aria-hidden="true">
                        <ProjectGlyph glyph={GENERAL_TASK_CARD.glyph} size={34} />
                      </div>
                      <p className="gz-npd-hero-eyebrow">Blank task</p>
                      <h4 className="gz-npd-hero-name">{GENERAL_TASK_CARD.label}</h4>
                      <p className="gz-npd-hero-description">
                        Name the job, describe what success looks like, and list the steps. It lands
                        ready to fire.
                      </p>
                    </div>
                  )}
                  <div className="gz-npd-pane-form">
                    {!projectLocked && (
                      <label>
                        Project
                        <Select.Root
                          value={projectId}
                          onValueChange={(v) => {
                            // A different project means a different shelf:
                            // re-fetch applicability + suggestions and drop
                            // any selection that may no longer apply.
                            setProjectId(v);
                            setSelectedBookId(null);
                            setParams({});
                            setActiveRail('all');
                            setRailInitialized(false);
                            setError('');
                          }}
                        >
                          <Select.Trigger>
                            <Select.Value />
                          </Select.Trigger>
                          <Select.Content>
                            {projects.map((p) => (
                              <Select.Item key={p.id} value={p.id}>
                                {p.name}
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Root>
                      </label>
                    )}
                    <label>
                      Title
                      <input
                        value={title}
                        onChange={(e) => {
                          setTitle(e.target.value);
                          setTitleTouched(true);
                        }}
                        placeholder={
                          selectedBook ? selectedBook.manifest.name : 'e.g. Ship the landing page'
                        }
                      />
                    </label>
                    {selectedNeeds.length > 0 && selectedBook && (
                      <div className="gz-ntd-needs">
                        <p className="gz-npd-give-eyebrow">Needs setup</p>
                        <CraftbookToolsetSetup
                          missing={selectedNeeds}
                          onAllInstalled={() => void loadCraftbooks()}
                          onCancel={selectGeneral}
                        />
                      </div>
                    )}
                    {selectedSchema && selectedNeeds.length === 0 && (
                      <div className="gz-npd-params">
                        <GezelJsonEditor
                          schema={selectedSchema}
                          value={params}
                          onChange={(next) => {
                            setParams((next ?? {}) as Record<string, unknown>);
                            setError('');
                          }}
                          density="compact"
                        />
                      </div>
                    )}
                    {!selectedBook && (
                      <>
                        <label>
                          Description <span className="muted">(40+ chars)</span>
                          <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                            placeholder="What's the problem? What does success look like for the user?"
                          />
                        </label>
                        <label>
                          Steps <span className="muted">(one per line)</span>
                          <textarea
                            value={stepNames}
                            onChange={(e) => setStepNames(e.target.value)}
                            rows={3}
                          />
                        </label>
                      </>
                    )}
                    <label>
                      Assign to
                      <Select.Root
                        value={resolvedAssigneeSel}
                        onValueChange={(v) => {
                          setAssigneeSel(v);
                          setAssigneeTouched(true);
                        }}
                      >
                        <Select.Trigger>
                          <Select.Value />
                        </Select.Trigger>
                        <Select.Content>
                          {entryRole && (
                            <Select.Item value={AUTO_ASSIGNEE}>
                              Auto — the {entryRole} for step 1
                            </Select.Item>
                          )}
                          {gezels.map((g) => (
                            <Select.Item key={g.id} value={g.id}>
                              {g.name}
                              {g.role ? ` — ${g.role}` : ''}
                            </Select.Item>
                          ))}
                          <Select.Item value="__user">Me (no gezel)</Select.Item>
                        </Select.Content>
                      </Select.Root>
                      {resolvedAssigneeSel === AUTO_ASSIGNEE ? (
                        <small className="muted">
                          Every step picks its own specialist by role when the task fires. Step 1
                          goes to the {entryRole}, and whoever that turns out to be owns the task.
                        </small>
                      ) : (
                        selectedBook && (
                          <small className="muted">
                            Steps that name a role pick their own specialist when the task fires —
                            this only covers steps that name none.
                          </small>
                        )
                      )}
                      {resolvedAssigneeSel === '__user' && (
                        <small className="muted">
                          Assigned to you — firing won't hand it to a gezel.
                        </small>
                      )}
                    </label>
                    {!selectedBook && (
                      <details className="gz-ntd-advanced">
                        <summary>Schedule (advanced)</summary>
                        <label>
                          Cron expression <span className="muted">(5-field)</span>
                          <input
                            value={cron}
                            placeholder="e.g. 0 9 * * 1 — every Monday 09:00"
                            onChange={(e) => setCron(e.target.value)}
                          />
                        </label>
                        {cron.trim() && (
                          <label>
                            Overlap policy
                            <Select.Root
                              value={cronOverlap}
                              onValueChange={(v) => setCronOverlap(v as TaskCronOverlap)}
                            >
                              <Select.Trigger>
                                <Select.Value />
                              </Select.Trigger>
                              <Select.Content>
                                <Select.Item value="skip">
                                  skip — don't spawn if a prior run is still active
                                </Select.Item>
                                <Select.Item value="queue">
                                  queue — always spawn, let the runner throttle
                                </Select.Item>
                                <Select.Item value="concurrent">
                                  concurrent — spawn unconditionally
                                </Select.Item>
                              </Select.Content>
                            </Select.Root>
                          </label>
                        )}
                      </details>
                    )}
                  </div>
                  {error && <p className="error small">{error}</p>}
                </div>
                <div className="gz-npd-pane-footer">
                  <p className="gz-ntd-footnote">
                    {scheduled
                      ? 'Scheduled tasks start active and run on their cadence.'
                      : 'Lands ready to fire — nothing runs until you fire it.'}
                  </p>
                  <Dialog.Actions>
                    <button type="button" onClick={onClose} disabled={busy}>
                      Cancel
                    </button>
                    <button type="submit" className="primary" disabled={createDisabled}>
                      {busy ? 'Creating…' : 'Create task'}
                    </button>
                  </Dialog.Actions>
                </div>
              </aside>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function GalleryCard({
  label,
  description,
  active,
  iconSvg,
  logoUrl,
  glyph,
  suggested = false,
  index,
  onSelect,
}: {
  label: string;
  description: string;
  active: boolean;
  iconSvg?: string;
  logoUrl?: string;
  glyph: Parameters<typeof ProjectGlyph>[0]['glyph'];
  suggested?: boolean;
  index: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      // biome-ignore lint/a11y/useSemanticElements: cards form one visual radio group; native inputs would duplicate the interactive surface.
      role="radio"
      aria-checked={active}
      aria-label={label}
      className={`gz-npd-card${active ? ' active' : ''}${suggested ? ' gz-ntd-card-suggested' : ''}`}
      onClick={onSelect}
      style={{ '--card-i': Math.min(index, 11) } as React.CSSProperties}
    >
      <span className="gz-npd-card-mark" aria-hidden="true">
        {iconSvg ? (
          <span
            className="gz-npd-card-mark-svg"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: catalog icon SVGs are server-sanitized before delivery.
            dangerouslySetInnerHTML={{ __html: iconSvg }}
          />
        ) : logoUrl ? (
          <img src={logoUrl} alt="" />
        ) : (
          <ProjectGlyph glyph={glyph} size={22} />
        )}
      </span>
      <span className="gz-npd-card-name">{label}</span>
      <span className="gz-npd-card-description">{description}</span>
    </button>
  );
}
