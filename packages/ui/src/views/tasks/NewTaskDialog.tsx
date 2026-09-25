import {
  type CraftbookToolsetNeed,
  type GezelSummary,
  type NewCraftbookStep,
  type Project,
  type PromptDraftTaskLaunch,
  type Task,
  type TaskAssignee,
  type TaskCronOverlap,
  type TaskInputSource,
  craftbookInputParams,
  launchFormParamSchema,
  mainContentParamKey,
  prioritizePullsForCurrentBranch,
  unmetParamAlternatives,
  visibleCatalogItems,
} from '@bendyline/gezel';
import type { SquisqAnnotatedSchema } from '@bendyline/squisq';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiErrorMessage } from '../../api-error.js';
import { api } from '../../api.js';
import { CatalogArtwork } from '../../components/CatalogArtwork.js';
import { CraftbookToolsetSetup } from '../../components/CraftbookToolsetSetup.js';
import { GezelJsonEditor } from '../../components/GezelJsonEditor.js';
import { MarkdownField } from '../../components/MarkdownField.js';
import {
  inputValuesFromLaunch,
  paramAlternativesMessage,
  taskLaunchFromDialog,
  uploadStagingIds,
} from '../../components/composer-task-launch.js';
import {
  CraftbookInputField,
  type CraftbookInputValue,
  EMPTY_INPUT_VALUE,
} from '../../components/craftbook-input/CraftbookInputField.js';
import { useShowWorkInProgressFeatures } from '../../components/useShowWorkInProgressFeatures.js';
import { Dialog, Select } from '../../primitives/index.js';
import { runtimeCapabilities } from '../../runtime-capabilities.js';
import { ProjectGlyph } from '../projects/new-project-meta.js';
import {
  type BookItem,
  GENERAL_TASK_CARD,
  composeCraftbookDescription,
  craftbookGlyph,
  craftbookHasParams,
  seedParamDefaults,
  stringifyParamValues,
  taskLensGroupLabel,
  taskLensesFor,
  toBookItems,
} from './new-task-meta.js';

/**
 * Sentinel for "let the entry step's role decide". Sends no assignee, so
 * the service stamps whoever the role resolved into.
 */
const AUTO_ASSIGNEE = '__auto';

export type TaskCreationMode = 'one-time' | 'scheduled' | 'night-shift';

const MODE_COPY: Record<
  TaskCreationMode,
  {
    title: string;
    subtitle: string;
    generalLabel: string;
    generalDescription: string;
    featuredLabel: string;
    featuredTitle: string;
    featuredTagline: string;
    submitLabel: string;
    footnote: string;
  }
> = {
  'one-time': {
    title: 'New Task',
    subtitle: 'Pick a craftbook — a proven recipe your crew follows step by step — or start blank.',
    generalLabel: GENERAL_TASK_CARD.label,
    generalDescription: GENERAL_TASK_CARD.description,
    featuredLabel: 'Recommended',
    featuredTitle: 'Recommended',
    featuredTagline: 'proven recipes for this kind of project',
    submitLabel: 'Create task',
    footnote: 'Lands ready to fire — nothing runs until you fire it.',
  },
  scheduled: {
    title: 'New Scheduled Task',
    subtitle: 'Choose a repeatable craftbook, then set when each fresh run should begin.',
    generalLabel: 'Blank scheduled task',
    generalDescription: 'Define a repeatable job from scratch and run a fresh copy on a cadence.',
    featuredLabel: 'For schedules',
    featuredTitle: 'Scheduled craftbooks',
    featuredTagline: 'recipes identified as safe for recurring unattended runs',
    submitLabel: 'Create schedule',
    footnote: 'Starts active and creates a fresh task on each scheduled run.',
  },
  'night-shift': {
    title: 'New Night Shift Task',
    subtitle: 'Choose work your crew can pick up unattended during the Night Shift window.',
    generalLabel: 'Blank Night Shift task',
    generalDescription: 'Define a one-off job that waits for Night Shift before it begins.',
    featuredLabel: 'For Night Shift',
    featuredTitle: 'Night Shift craftbooks',
    featuredTagline: 'recipes identified as safe for unattended overnight work',
    submitLabel: 'Queue for Night Shift',
    footnote: 'Starts active, but only runs while Night Shift is on.',
  },
};

/**
 * Modal for creating a new task, mirroring the New Project dialog's
 * gallery layout: a category rail, a card gallery whose star section is
 * the craftbooks recommended for this project, and a right-hand pane
 * with the selected recipe's steps + the task's properties.
 *
 * One-time craftbook tasks start immediately; blank one-time tasks land as
 * inert drafts ("ready to fire"). Scheduled mode creates an active host that
 * clones a fresh child on each tick; Night Shift creates active work whose
 * dispatch is gated to the configured shift.
 *
 * In `compose` launch mode nothing is created here at all: the configured
 * craftbook is handed back to the chat composer as its attached task, and
 * the message the person sends becomes the brief. Reopened from the
 * composer's strip, the dialog lands straight on that book's configuration
 * with every value restored.
 */
export function NewTaskDialog({
  open,
  creationMode = 'one-time',
  launchMode = 'immediate',
  initialLaunch,
  composerText,
  onComposerTextChange,
  onUseInChat,
  defaultProjectId,
  projects,
  gezels,
  projectLocked,
  onClose,
  onCreated,
}: {
  open: boolean;
  creationMode?: TaskCreationMode;
  /** `compose`: hand the configuration to a chat composer instead of creating. */
  launchMode?: 'immediate' | 'compose';
  /** Compose mode: the attached task to reopen on, values restored. */
  initialLaunch?: PromptDraftTaskLaunch | null;
  /** Compose mode: the message so far, shown as the task's brief. */
  composerText?: string;
  /**
   * Compose mode: an edit to the brief, written straight back to the chat
   * box so the two stay one text. Without it the brief is read-only.
   */
  onComposerTextChange?: (text: string) => void;
  onUseInChat?: (launch: PromptDraftTaskLaunch) => void;
  defaultProjectId: string;
  projects: Project[];
  gezels: GezelSummary[];
  /** When true, the view is pinned to one project — hide the project picker. */
  projectLocked: boolean;
  onClose: () => void;
  onCreated?: (created: Task) => Promise<void> | void;
}) {
  const modeCopy = MODE_COPY[creationMode];
  const composeMode = launchMode === 'compose';
  const showWorkInProgressFeatures = useShowWorkInProgressFeatures();
  const [projectId, setProjectId] = useState(defaultProjectId);
  // Gallery data — re-fetched per project (applicability + suggestions
  // depend on the project's type and GitHub/branch state).
  const [books, setBooks] = useState<BookItem[]>([]);
  const [booksLoaded, setBooksLoaded] = useState(false);
  const craftbookLoadSequence = useRef(0);
  const [missingToolsets, setMissingToolsets] = useState<Record<string, CraftbookToolsetNeed[]>>(
    {},
  );
  const [projectType, setProjectType] = useState<{ id: string; label: string } | null>(null);
  const [suggestedIds, setSuggestedIds] = useState<Set<string>>(new Set());
  // Selection: null = the General (blank) card; else a craftbook id.
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  /**
   * Wizard step. `pick` is the catalog — rail + gallery across the whole
   * dialog. `configure` is the chosen recipe in full: what it does, every
   * step it runs, and its parameters, with nothing clamped into a 19rem
   * column. A craftbook is a page of reading, not a card's worth.
   */
  const [step, setStep] = useState<'pick' | 'configure'>('pick');
  /**
   * Whether the blank card is a *choice* rather than just "nothing picked
   * yet" — both read as `selectedBookId === null`, and only the former
   * should light the card when the user steps back to the gallery.
   */
  const [generalChosen, setGeneralChosen] = useState(false);
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
  // Craftbook inputs — the files the run works on — keyed by param. Kept out
  // of `params` because a pick is a source (and maybe an upload), not a string.
  const [inputValues, setInputValues] = useState<Record<string, CraftbookInputValue>>({});
  const stagedRef = useRef({ projectId: defaultProjectId, inputValues });
  stagedRef.current = { projectId, inputValues };
  const [cron, setCron] = useState('');
  const [cronOverlap, setCronOverlap] = useState<TaskCronOverlap>('skip');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Pre-flight for craftbooks that resolve a pull request at launch: the
  // corpus is materialized server-side before the first step, so "no open
  // PR for this branch" is knowable now rather than as a 409 later.
  const [pullHint, setPullHint] = useState<string | null>(null);
  const pullHintSequence = useRef(0);
  // Compose mode: the book to finish seeding once the catalog listing lands
  // (declared defaults go underneath the restored values), and whether the
  // configuration left through "Use in chat" — its uploads then belong to
  // the composer's strip, not to a launch that never happened.
  const seedPendingRef = useRef<string | null>(null);
  const handedOffRef = useRef(false);
  const initialLaunchRef = useRef(initialLaunch ?? null);
  initialLaunchRef.current = initialLaunch ?? null;

  // Reset per open so the dialog never reopens half-filled. The compose-mode
  // restore lives in the same effect, after the reset: a second effect would
  // race it and lose. `initialLaunch` is read through a ref on purpose — it
  // changes while the dialog is open (a PATCH echo) and must not reset the
  // form.
  useEffect(() => {
    if (!open) return;
    setProjectId(defaultProjectId);
    setSelectedBookId(null);
    setGeneralChosen(false);
    setStep('pick');
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
    setInputValues({});
    setCron('');
    setCronOverlap('skip');
    setBusy(false);
    setError('');
    setPullHint(null);
    handedOffRef.current = false;
    seedPendingRef.current = null;
    const restore = launchMode === 'compose' ? initialLaunchRef.current : null;
    if (restore) {
      setSelectedBookId(restore.craftbookId);
      setStep('configure');
      setParams(restore.params);
      setInputValues(inputValuesFromLaunch(restore));
      setTitle(restore.title ?? '');
      setTitleTouched(Boolean(restore.title));
      const assignee = restore.assignee;
      setAssigneeSel(assignee ? (assignee.kind === 'user' ? '__user' : assignee.gezelId) : '');
      setAssigneeTouched(Boolean(assignee));
      seedPendingRef.current = restore.craftbookId;
    }
  }, [open, defaultProjectId, launchMode]);

  // Files uploaded for a launch that never happened would otherwise sit in
  // staging until the daemon's sweep. After a successful launch the upload
  // was already adopted, so the delete is a harmless no-op. In compose mode
  // the uploads that rode in on the strip, or left on it, are still wanted.
  useEffect(() => {
    if (open) return;
    const keep = new Set<string>(
      launchMode !== 'compose'
        ? []
        : handedOffRef.current
          ? Object.values(stagedRef.current.inputValues).flatMap((value) =>
              value.source?.from === 'upload' ? [value.source.stagingId] : [],
            )
          : uploadStagingIds(initialLaunchRef.current),
    );
    discardStagedInputs(stagedRef.current.projectId, stagedRef.current.inputValues, keep);
  }, [open, launchMode]);

  const loadCraftbooks = useCallback(async () => {
    const sequence = ++craftbookLoadSequence.current;
    if (!projectId) {
      if (sequence !== craftbookLoadSequence.current) return;
      setBooks([]);
      setBooksLoaded(true);
      return;
    }
    try {
      const res = await api.listProjectCraftbooks(projectId);
      if (sequence !== craftbookLoadSequence.current) return;
      const visibleItems = visibleCatalogItems(res.items ?? [], showWorkInProgressFeatures);
      const visibleIds = new Set(visibleItems.map((item) => item.manifest.id));
      setBooks(toBookItems(visibleItems));
      setMissingToolsets(res.missingToolsets ?? {});
      setProjectType(res.projectType ?? null);
      setSuggestedIds(new Set((res.suggestedIds ?? []).filter((id) => visibleIds.has(id))));
      setSelectedBookId((current) => (current && !visibleIds.has(current) ? null : current));
    } catch {
      if (sequence !== craftbookLoadSequence.current) return;
      // Craftbooks are best-effort — the General card always works.
      setBooks([]);
      setMissingToolsets({});
      setProjectType(null);
      setSuggestedIds(new Set());
    } finally {
      if (sequence === craftbookLoadSequence.current) setBooksLoaded(true);
    }
  }, [projectId, showWorkInProgressFeatures]);

  useEffect(() => {
    if (!open) return;
    setBooksLoaded(false);
    void loadCraftbooks();
  }, [open, loadCraftbooks]);

  // Finish a compose-mode restore once the listing answers: declared
  // defaults underneath the restored values, or back to the gallery with a
  // reason when the book is no longer offered here.
  useEffect(() => {
    if (!open || !booksLoaded) return;
    const pending = seedPendingRef.current;
    if (!pending) return;
    seedPendingRef.current = null;
    const book = books.find((candidate) => candidate.manifest.id === pending);
    if (!book) {
      setSelectedBookId(null);
      setStep('pick');
      setError('That craftbook is no longer available in this project.');
      return;
    }
    setParams((prev) => ({ ...seedParamDefaults(book.manifest.paramSchema), ...prev }));
  }, [open, booksLoaded, books]);

  // Land on the project's recommended shelf when it has one (once per
  // open/project — user shelf picks stick after that).
  useEffect(() => {
    if (!open || !booksLoaded || railInitialized) return;
    setRailInitialized(true);
    const hasFeatured =
      creationMode === 'one-time'
        ? suggestedIds.size > 0
        : books.some((book) =>
            creationMode === 'scheduled'
              ? book.manifest.runModes?.scheduled
              : book.manifest.runModes?.nightShift,
          );
    if (hasFeatured) setActiveRail('recommended');
  }, [open, booksLoaded, railInitialized, suggestedIds, creationMode, books]);

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

  // A scheduled host performs no work itself — its craftbook resolves per
  // tick, so there is nothing to pre-flight here.
  const resolvesPullAtLaunch =
    creationMode !== 'scheduled' &&
    (selectedBook?.manifest.connectors ?? []).some(
      (need) => need.typeId === 'github-pulls' && !need.optional,
    );
  const explicitPullNumber = String((params as { number?: unknown }).number ?? '').trim();

  useEffect(() => {
    const sequence = ++pullHintSequence.current;
    setPullHint(null);
    if (!runtimeCapabilities().git || !open || !resolvesPullAtLaunch || !projectId) return;
    void (async () => {
      try {
        const [status, openPulls] = await Promise.all([
          api.getProjectGitStatus(projectId),
          api.listProjectGitHubPulls(projectId),
        ]);
        if (sequence !== pullHintSequence.current) return;
        // Same ranking the daemon's launch prep uses, so the warning and
        // the outcome cannot disagree.
        const { matchingCount } = prioritizePullsForCurrentBranch(
          openPulls.pulls ?? [],
          status.branch,
        );
        if (matchingCount > 0) return;
        setPullHint(
          status.branch
            ? `No open pull request for branch "${status.branch}" — enter a pull request number above, or switch branches first.`
            : 'This checkout is not on a branch — enter a pull request number above.',
        );
      } catch {
        // Best-effort: a failed probe just leaves the launch to report the
        // real reason itself.
      }
    })();
  }, [open, resolvesPullAtLaunch, projectId]);

  const selectGeneral = useCallback(() => {
    setSelectedBookId(null);
    setGeneralChosen(true);
    setParams({});
    setError('');
    setStep('configure');
    if (!titleTouched) setTitle('');
  }, [titleTouched]);

  /** Back to the catalog. The selection survives, so the card is still lit. */
  const backToPicker = useCallback(() => {
    setStep('pick');
    setError('');
  }, []);

  /**
   * A different project means a different shelf: re-fetch applicability +
   * suggestions and drop any selection that may no longer apply. Lives on
   * the picker step, because it decides what the gallery even holds.
   */
  const changeProject = useCallback((next: string) => {
    discardStagedInputs(stagedRef.current.projectId, stagedRef.current.inputValues);
    setProjectId(next);
    setSelectedBookId(null);
    setGeneralChosen(false);
    setParams({});
    setInputValues({});
    setActiveRail('all');
    setRailInitialized(false);
    setError('');
  }, []);

  const selectBook = useCallback(
    (b: BookItem) => {
      // Re-selecting the same book (back to the gallery and in again) keeps
      // its picks; a different book's inputs mean different files.
      if (selectedBookId !== b.manifest.id) {
        discardStagedInputs(stagedRef.current.projectId, stagedRef.current.inputValues);
        setInputValues({});
      }
      setSelectedBookId(b.manifest.id);
      setGeneralChosen(false);
      setParams(seedParamDefaults(b.manifest.paramSchema));
      setError('');
      setStep('configure');
      if (!titleTouched) setTitle(b.manifest.name);
      if (!assigneeTouched) {
        const d = b.manifest.defaultAssignee;
        if (d?.kind === 'gezel' && gezels.some((g) => g.id === d.gezelId)) {
          setAssigneeSel(d.gezelId);
        }
      }
    },
    [titleTouched, assigneeTouched, gezels, selectedBookId],
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

  const suggestedBooks = useMemo(() => {
    if (creationMode === 'one-time') {
      return books.filter((b) => suggestedIds.has(b.manifest.id));
    }
    const key = creationMode === 'scheduled' ? 'scheduled' : 'nightShift';
    return books
      .filter((b) => b.manifest.runModes?.[key])
      .sort((a, b) => {
        const aRecommended = a.manifest.runModes?.[key] === 'recommended' ? 1 : 0;
        const bRecommended = b.manifest.runModes?.[key] === 'recommended' ? 1 : 0;
        return bRecommended - aRecommended || a.manifest.name.localeCompare(b.manifest.name);
      });
  }, [books, suggestedIds, creationMode]);
  const isRecommended = useCallback(
    (book: BookItem) => {
      if (creationMode === 'one-time') return suggestedIds.has(book.manifest.id);
      const key = creationMode === 'scheduled' ? 'scheduled' : 'nightShift';
      return book.manifest.runModes?.[key] === 'recommended';
    },
    [creationMode, suggestedIds],
  );
  const filteredBooks = useMemo(() => {
    if (!searching) return books;
    return books
      .filter((b) =>
        `${b.manifest.id} ${b.manifest.name} ${b.manifest.description} ${(b.manifest.tags ?? []).join(' ')}`
          .toLowerCase()
          .includes(normalizedQuery),
      )
      .sort((a, b) => {
        const aRecommended =
          suggestedIds.has(a.manifest.id) || a.manifest.tags?.includes('recommended') ? 1 : 0;
        const bRecommended =
          suggestedIds.has(b.manifest.id) || b.manifest.tags?.includes('recommended') ? 1 : 0;
        return (
          bRecommended - aRecommended ||
          craftbookSearchRank(a, normalizedQuery) - craftbookSearchRank(b, normalizedQuery) ||
          a.manifest.name.localeCompare(b.manifest.name)
        );
      });
  }, [books, searching, normalizedQuery, suggestedIds]);
  const generalMatches =
    !searching ||
    `${modeCopy.generalLabel} ${modeCopy.generalDescription} blank fresh`
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
          title:
            creationMode === 'one-time' && projectType
              ? `Recommended for ${projectType.label}`
              : modeCopy.featuredTitle,
          tagline: modeCopy.featuredTagline,
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
  }, [
    searching,
    query,
    filteredBooks,
    activeRail,
    suggestedBooks,
    projectType,
    lenses,
    books,
    creationMode,
    modeCopy,
  ]);

  const selectedNeeds: CraftbookToolsetNeed[] = selectedBook
    ? (missingToolsets[selectedBook.manifest.id] ?? [])
    : [];

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;
      // Enter in the picker's search box submits the form implicitly; the
      // task is not configured yet, so nothing may be created from there.
      if (step !== 'configure') return;
      setError('');
      if (!projectId) {
        setError('Pick a project.');
        return;
      }
      const cronExpr = cron.trim();
      if (creationMode === 'scheduled' && !cronExpr) {
        setError('Enter a schedule.');
        return;
      }

      // CRAFTBOOK: resolved from the catalog; embedded at create time.
      if (selectedBook) {
        const m = selectedBook.manifest;
        if ((missingToolsets[m.id]?.length ?? 0) > 0) {
          setError('This craftbook needs its toolsets installed first — see the setup list.');
          return;
        }
        const inputParams = craftbookInputParams(m.paramSchema);
        if (inputParams.some((input) => inputValues[input.key]?.busy)) {
          setError('Wait for the files to finish uploading.');
          return;
        }
        const missingInput = inputParams.find(
          (input) => input.required && !inputValues[input.key]?.source,
        );
        if (missingInput) {
          setError(`Choose the ${missingInput.title.toLowerCase()} this craftbook works on.`);
          return;
        }
        // In compose mode the chat message is the brief, and the brief is the
        // book's main content: it is never a field here and never missing.
        const briefKey = launchMode === 'compose' ? mainContentParamKey(m.paramSchema) : null;
        const briefFills = briefKey ? [briefKey] : [];
        const schema = launchFormParamSchema(m.paramSchema, briefFills) as
          | SquisqAnnotatedSchema
          | undefined;
        const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
        const missingKey = required.find((k) => {
          const v = params[k];
          return v === undefined || v === null || v === '';
        });
        if (missingKey) {
          setError(`"${missingKey}" is required.`);
          return;
        }
        const unmet = unmetParamAlternatives(m.paramSchema, params, [
          ...briefFills,
          ...inputParams.filter((input) => inputValues[input.key]?.source).map((i) => i.key),
        ]);
        if (unmet) {
          setError(paramAlternativesMessage(m.paramSchema, unmet));
          return;
        }
        // Compose mode stops here: the configuration goes to the composer's
        // strip and the task is created when the message is sent.
        if (launchMode === 'compose') {
          handedOffRef.current = true;
          onUseInChat?.(
            taskLaunchFromDialog({
              manifest: m,
              item: selectedBook.item,
              params: briefKey
                ? Object.fromEntries(Object.entries(params).filter(([key]) => key !== briefKey))
                : params,
              inputValues,
              title,
              assignee,
              origin: 'user',
            }),
          );
          onClose();
          return;
        }
        const stringified = stringifyParamValues(params);
        const inputSources: Record<string, TaskInputSource> = {};
        const inputLabels: Record<string, string> = {};
        for (const input of inputParams) {
          const value = inputValues[input.key];
          if (!value?.source) continue;
          inputSources[input.key] = value.source;
          inputLabels[input.key] =
            value.fileCount !== undefined
              ? `${value.label ?? input.key} (${value.fileCount} file${value.fileCount === 1 ? '' : 's'})`
              : (value.label ?? input.key);
        }
        // A schedule re-runs from the project each tick, so its spawned book
        // gets the workspace path as the plain string every launcher accepts.
        const scheduledInputParams = Object.fromEntries(
          Object.entries(inputSources).flatMap(([key, source]) =>
            source.from === 'workspace' ? [[key, source.path]] : [],
          ),
        );
        setBusy(true);
        try {
          const created =
            creationMode === 'scheduled'
              ? await api.createTask(projectId, {
                  title: title.trim() || m.name,
                  description: `Recurring scheduled task. ${composeCraftbookDescription(m, { ...stringified, ...inputLabels })} Each scheduled run creates a fresh task from this recipe.`,
                  steps: [
                    {
                      name: 'Wait for schedule',
                      prompt:
                        'This host holds a recurring schedule. It does not perform the work itself; each tick creates a fresh child task.',
                    },
                  ],
                  spawnsCraftbookId: m.id,
                  ...(selectedBook.item.sourceId
                    ? { spawnsCraftbookSourceId: selectedBook.item.sourceId }
                    : {}),
                  ...(assignee ? { assignee } : {}),
                  cron: { expression: cronExpr, overlap: cronOverlap },
                  ...(Object.keys(stringified).length + Object.keys(scheduledInputParams).length > 0
                    ? { spawnsCraftbookParams: { ...stringified, ...scheduledInputParams } }
                    : {}),
                })
              : await api.createTask(projectId, {
                  title: title.trim() || m.name,
                  description: composeCraftbookDescription(m, { ...stringified, ...inputLabels }),
                  ...(Object.keys(inputSources).length > 0 ? { inputs: inputSources } : {}),
                  craftbookId: m.id,
                  ...(selectedBook.item.sourceId
                    ? { craftbookSourceId: selectedBook.item.sourceId }
                    : {}),
                  ...(assignee ? { assignee } : {}),
                  ...(creationMode === 'one-time'
                    ? { dispatchEntry: true }
                    : { nightShift: { enabled: true }, dispatchEntry: true }),
                  ...(Object.keys(stringified).length > 0 ? { craftbookParams: stringified } : {}),
                });
          // Stamp invocation params as an entry-step note (best-effort),
          // mirroring the terminal launcher, so the gezel reads them via
          // `read_task_notes` when the task fires.
          if (
            creationMode !== 'scheduled' &&
            Object.keys(stringified).length > 0 &&
            created.activeStepId
          ) {
            const lines = ['# Invocation parameters', ''];
            for (const [k, v] of Object.entries(stringified)) lines.push(`- **${k}**: ${v}`);
            await api
              .appendTaskNote(created.projectId, created.num, {
                text: lines.join('\n'),
                stepId: created.activeStepId,
              })
              .catch(() => {});
          }
          await onCreated?.(created);
          onClose();
        } catch (err) {
          setError(apiErrorMessage(err));
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
      setBusy(true);
      try {
        const created =
          creationMode === 'scheduled'
            ? await api.createTask(projectId, {
                title: t,
                description: description.trim(),
                steps: [
                  {
                    name: 'Wait for schedule',
                    prompt:
                      'This host holds a recurring schedule. It does not perform the work itself; each tick creates a fresh child task.',
                  },
                ],
                spawnsSteps: steps,
                ...(assignee ? { assignee } : {}),
                cron: { expression: cronExpr, overlap: cronOverlap },
              })
            : await api.createTask(projectId, {
                title: t,
                description: description.trim(),
                steps,
                ...(assignee ? { assignee } : {}),
                ...(creationMode === 'one-time'
                  ? { status: 'draft' as const }
                  : { nightShift: { enabled: true }, dispatchEntry: true }),
              });
        await onCreated?.(created);
        onClose();
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      step,
      creationMode,
      launchMode,
      projectId,
      selectedBook,
      missingToolsets,
      params,
      inputValues,
      title,
      assignee,
      description,
      stepNames,
      cron,
      cronOverlap,
      onCreated,
      onUseInChat,
      onClose,
    ],
  );

  // Inputs render as source pickers of their own, params the daemon or
  // another screen fills are never asked, and in compose mode the brief box
  // stands in for the book's main content param. The generic form gets the
  // rest of the schema, and disappears when nothing is left to ask.
  const selectedInputs = selectedBook
    ? craftbookInputParams(selectedBook.manifest.paramSchema)
    : [];
  const composeBriefKey =
    composeMode && selectedBook ? mainContentParamKey(selectedBook.manifest.paramSchema) : null;
  const nonInputParamSchema = selectedBook
    ? launchFormParamSchema(
        selectedBook.manifest.paramSchema,
        composeBriefKey ? [composeBriefKey] : [],
      )
    : undefined;
  const selectedSchema =
    selectedBook &&
    craftbookHasParams({ ...selectedBook.manifest, paramSchema: nonInputParamSchema })
      ? (nonInputParamSchema as SquisqAnnotatedSchema)
      : null;
  const inputBusy = selectedInputs.some((input) => inputValues[input.key]?.busy);
  // A restored selection whose book the listing has not delivered yet. The
  // configure pane must not flash the blank-task form in the meantime.
  const pendingBook = Boolean(selectedBookId && !selectedBook);
  const createDisabled =
    busy || inputBusy || pendingBook || (selectedBook !== null && selectedNeeds.length > 0);

  const heroEyebrow = selectedBook
    ? `Craftbook${
        isRecommended(selectedBook)
          ? creationMode === 'night-shift'
            ? ' · recommended for Night Shift'
            : creationMode === 'scheduled'
              ? ' · recommended for schedules'
              : ' · recommended'
          : ''
      }`
    : creationMode === 'one-time'
      ? 'Blank task'
      : creationMode === 'scheduled'
        ? 'Blank schedule'
        : 'Blank Night Shift task';
  const projectName = projects.find((p) => p.id === projectId)?.name ?? '';

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={`gz-npd gz-ntd gz-npd-step-${step}`}>
          <form onSubmit={handleSubmit} style={{ display: 'contents' }}>
            {step === 'pick' ? (
              <>
                <header className="gz-npd-header">
                  <div className="gz-npd-header-copy">
                    <Dialog.Title asChild>
                      <h3>{composeMode ? 'Task for this message' : modeCopy.title}</h3>
                    </Dialog.Title>
                    <p className="gz-npd-header-sub">
                      {composeMode
                        ? 'Pick a craftbook to attach to your message.'
                        : modeCopy.subtitle}
                    </p>
                  </div>
                  <div className="gz-ntd-header-controls">
                    {!projectLocked && (
                      <label className="gz-ntd-header-project">
                        <span>Project</span>
                        <Select.Root value={projectId} onValueChange={changeProject}>
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
                    <label className="gz-npd-search">
                      <span className="sr-only">Search craftbooks</span>
                      <input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search craftbooks…"
                      />
                    </label>
                  </div>
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
                        <span className="gz-npd-rail-label">{modeCopy.featuredLabel}</span>
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
                    {lenses.map((lens, index) => {
                      const groupLabel =
                        lenses[index - 1]?.family === lens.family
                          ? null
                          : taskLensGroupLabel(lens.family);
                      return (
                        <Fragment key={lens.id}>
                          {groupLabel && <span className="gz-npd-rail-group">{groupLabel}</span>}
                          <button
                            type="button"
                            className={`gz-npd-rail-item${!searching && activeRail === lens.id ? ' active' : ''}`}
                            onClick={() => setActiveRail(lens.id)}
                          >
                            <ProjectGlyph glyph={lens.glyph} size={16} />
                            <span className="gz-npd-rail-label">{lens.label}</span>
                            <span className="gz-npd-rail-count">{lens.bookIds.size}</span>
                          </button>
                        </Fragment>
                      );
                    })}
                  </nav>
                  <div className="gz-npd-gallery" role="radiogroup" aria-label="Task type">
                    {generalMatches && !composeMode && (
                      <section className="gz-npd-section">
                        <div className="gz-npd-section-head">
                          <span className="gz-npd-section-title">Start fresh</span>
                        </div>
                        <div className="gz-npd-grid">
                          <GalleryCard
                            label={modeCopy.generalLabel}
                            description={modeCopy.generalDescription}
                            glyph={GENERAL_TASK_CARD.glyph}
                            index={0}
                            active={generalChosen}
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
                                suggested={isRecommended(b)}
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
                </div>
                <div className="gz-npd-pane-footer gz-npd-pick-footer">
                  <p className="gz-npd-footnote">
                    Pick one to see what it does — nothing is created until the next screen.
                  </p>
                  <Dialog.Actions>
                    <button type="button" onClick={onClose}>
                      Cancel
                    </button>
                  </Dialog.Actions>
                </div>
              </>
            ) : (
              <>
                <header className="gz-npd-header gz-npd-detail-header">
                  <button type="button" className="gz-npd-back" onClick={backToPicker}>
                    <span aria-hidden="true">‹</span>
                    {selectedBook ? 'Craftbooks' : 'Back'}
                  </button>
                  <div className="gz-npd-detail-id">
                    <span className="gz-npd-detail-art" aria-hidden="true">
                      {selectedBook ? (
                        <CatalogArtwork
                          {...(selectedBook.item.iconSvg
                            ? { iconSvg: selectedBook.item.iconSvg }
                            : {})}
                          {...(selectedBook.item.logoUrl
                            ? { logoUrl: selectedBook.item.logoUrl }
                            : {})}
                          svgClassName="gz-npd-hero-art-svg"
                          fallback={
                            <ProjectGlyph glyph={craftbookGlyph(selectedBook.manifest)} size={26} />
                          }
                        />
                      ) : (
                        <ProjectGlyph glyph={GENERAL_TASK_CARD.glyph} size={26} />
                      )}
                    </span>
                    <div className="gz-npd-header-copy">
                      <p className="gz-npd-hero-eyebrow">{heroEyebrow}</p>
                      <Dialog.Title asChild>
                        <h3 className="gz-npd-hero-name">
                          {selectedBook
                            ? selectedBook.manifest.name
                            : pendingBook
                              ? 'Loading craftbook…'
                              : modeCopy.generalLabel}
                        </h3>
                      </Dialog.Title>
                    </div>
                  </div>
                  {!projectLocked && projectName && (
                    <p className="gz-ntd-detail-project">
                      in <strong>{projectName}</strong>
                    </p>
                  )}
                </header>
                <div
                  className="gz-npd-detail"
                  data-blank={selectedBook || pendingBook ? undefined : 'true'}
                  key={selectedBookId ?? '__general'}
                >
                  {pendingBook && <p className="gz-npd-empty">Loading craftbook…</p>}
                  {selectedBook && (
                    <div className="gz-npd-brief">
                      <p className="gz-npd-brief-lede">{selectedBook.manifest.description}</p>
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
                          {selectedBook.manifest.steps.length} step
                          {selectedBook.manifest.steps.length === 1 ? '' : 's'}
                        </p>
                        <ol className="gz-ntd-steps-list">
                          {selectedBook.manifest.steps.map((s) => (
                            <li key={s.id}>
                              <span className="gz-ntd-step-head">
                                <span className="gz-ntd-step-name">{s.name}</span>
                                {s.suggestedRole && (
                                  <span className="gz-ntd-step-role">{s.suggestedRole}</span>
                                )}
                              </span>
                              {s.description && (
                                <span className="gz-ntd-step-note">{s.description}</span>
                              )}
                            </li>
                          ))}
                        </ol>
                      </div>
                    </div>
                  )}
                  <div className="gz-npd-setup" hidden={pendingBook}>
                    {!selectedBook && !pendingBook && (
                      <p className="gz-npd-brief-lede">{modeCopy.generalDescription}</p>
                    )}
                    <div className="gz-npd-pane-form">
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
                      {composeMode && selectedBook && (
                        <div className="gz-ntd-brief-from-message">
                          <p className="gz-npd-give-eyebrow">Brief · your chat message</p>
                          {onComposerTextChange ? (
                            <MarkdownField
                              key={selectedBook.manifest.id}
                              value={composerText ?? ''}
                              placeholder="What should this be about? Edits here change your chat message too."
                              minHeight="96px"
                              maxHeight="30vh"
                              onChange={onComposerTextChange}
                              onCommit={onComposerTextChange}
                            />
                          ) : composerText?.trim() ? (
                            <p className="gz-ntd-brief-text">{composerText}</p>
                          ) : (
                            <p className="gz-ntd-brief-empty muted">
                              Write the brief in the chat box. It becomes this task's description.
                            </p>
                          )}
                        </div>
                      )}
                      {selectedNeeds.length > 0 && selectedBook && (
                        <div className="gz-ntd-needs">
                          <p className="gz-npd-give-eyebrow">Needs setup</p>
                          <CraftbookToolsetSetup
                            missing={selectedNeeds}
                            onAllInstalled={() => void loadCraftbooks()}
                            onCancel={backToPicker}
                          />
                        </div>
                      )}
                      {selectedBook && selectedInputs.length > 0 && selectedNeeds.length === 0 && (
                        <div className="gz-npd-params">
                          <p className="gz-npd-give-eyebrow">Works on</p>
                          {selectedInputs.map((input) => (
                            <CraftbookInputField
                              key={`${projectId}:${selectedBook.manifest.id}:${input.key}`}
                              projectId={projectId}
                              craftbookId={selectedBook.manifest.id}
                              input={input}
                              allowUpload={creationMode !== 'scheduled'}
                              value={inputValues[input.key] ?? EMPTY_INPUT_VALUE}
                              onChange={(next) => {
                                setInputValues((prev) => ({ ...prev, [input.key]: next }));
                                setError('');
                              }}
                            />
                          ))}
                        </div>
                      )}
                      {selectedSchema && selectedNeeds.length === 0 && (
                        <div className="gz-npd-params">
                          <p className="gz-npd-give-eyebrow">Parameters</p>
                          <GezelJsonEditor
                            schema={selectedSchema}
                            value={params}
                            onChange={(next) => {
                              setParams((next ?? {}) as Record<string, unknown>);
                              setError('');
                            }}
                            density="comfortable"
                          />
                        </div>
                      )}
                      {!selectedBook && (
                        <>
                          <label>
                            Description <span className="muted">· a sentence or two</span>
                            <textarea
                              value={description}
                              onChange={(e) => setDescription(e.target.value)}
                              rows={4}
                              placeholder="What's the problem? What does success look like for the user?"
                            />
                          </label>
                          <label>
                            Steps <span className="muted">(one per line)</span>
                            <textarea
                              value={stepNames}
                              onChange={(e) => setStepNames(e.target.value)}
                              rows={4}
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
                      {creationMode === 'scheduled' && (
                        <div className="gz-ntd-schedule">
                          <p className="gz-npd-give-eyebrow">Schedule</p>
                          <label>
                            Cron expression <span className="muted">(UTC, 5-field)</span>
                            <input
                              value={cron}
                              placeholder="e.g. 0 9 * * 1 — every Monday 09:00"
                              onChange={(e) => setCron(e.target.value)}
                            />
                          </label>
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
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                {/* Every submit failure renders HERE, in the fixed footer
                    beside the button — never inside the scrolling body above,
                    where a message lands below the fold on a pane parked at
                    the top and the launch reads as a dead button. */}
                <div className="gz-npd-pane-footer gz-npd-detail-footer">
                  {error ? (
                    <p className="error small gz-npd-submit-error" role="alert">
                      {error}
                    </p>
                  ) : pullHint && !explicitPullNumber ? (
                    <p className="gz-npd-footnote gz-ntd-launch-hint">{pullHint}</p>
                  ) : (
                    <p className="gz-npd-footnote">
                      {composeMode
                        ? 'Nothing runs yet. It attaches to your message and starts when you send.'
                        : creationMode === 'one-time' && selectedBook
                          ? 'Starts immediately — the first gezel gets to work as soon as you create it.'
                          : modeCopy.footnote}
                    </p>
                  )}
                  <Dialog.Actions>
                    <button type="button" onClick={onClose} disabled={busy}>
                      Cancel
                    </button>
                    <button type="submit" className="primary" disabled={createDisabled}>
                      {composeMode
                        ? 'Use in chat'
                        : busy
                          ? creationMode === 'one-time' && selectedBook
                            ? 'Starting…'
                            : 'Creating…'
                          : creationMode === 'one-time' && selectedBook
                            ? 'Create & start'
                            : modeCopy.submitLabel}
                    </button>
                  </Dialog.Actions>
                </div>
              </>
            )}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Drop any upload staged for inputs that will not be launched. Fire-and-
 * forget. `keep` names the staging ids that still belong to something (the
 * composer's attached task) and must survive.
 */
function discardStagedInputs(
  projectId: string,
  values: Record<string, CraftbookInputValue>,
  keep: ReadonlySet<string> = new Set(),
): void {
  for (const value of Object.values(values)) {
    if (value.source?.from === 'upload' && !keep.has(value.source.stagingId)) {
      void api.taskInputs.deleteInputStaging(projectId, value.source.stagingId).catch(() => {});
    }
  }
}

function craftbookSearchRank(book: BookItem, query: string): number {
  const name = book.manifest.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(/\s+/).some((word) => word.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  const aliases = `${book.manifest.id} ${(book.manifest.tags ?? []).join(' ')}`.toLowerCase();
  return aliases.includes(query) ? 4 : 5;
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
        <CatalogArtwork
          {...(iconSvg ? { iconSvg } : {})}
          {...(logoUrl ? { logoUrl } : {})}
          svgClassName="gz-npd-card-mark-svg"
          fallback={<ProjectGlyph glyph={glyph} size={22} />}
        />
      </span>
      <span className="gz-npd-card-name">{label}</span>
      <span className="gz-npd-card-description">{description}</span>
    </button>
  );
}
