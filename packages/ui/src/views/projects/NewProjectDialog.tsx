import {
  type CatalogItemSummary,
  type GitHubIdentity,
  type GitHubRepoSummary,
  type ProjectDetail,
  type ProjectTypeCategory,
  connectorCraftbookIds,
  visibleCatalogItems,
} from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import type { SquisqAnnotatedSchema } from '@bendyline/squisq';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { CatalogArtwork } from '../../components/CatalogArtwork.js';
import { GezelIcon } from '../../components/GezelIcon.js';
import { GezelJsonEditor } from '../../components/GezelJsonEditor.js';
import { GitHubSignInChip } from '../../components/GithubSignInChip.js';
import { connectMailboxOAuth, linkImapMailbox } from '../../components/mail-link.js';
import { useKlerkInfo } from '../../components/transform/useKlerkInfo.js';
import { useShowWorkInProgressFeatures } from '../../components/useShowWorkInProgressFeatures.js';
import { Dialog, DropdownChevron } from '../../primitives/index.js';
import { NewProjectPaneHero, type PaneSelection } from './NewProjectDetailPane.js';
import {
  PROJECT_CATEGORIES,
  PROJECT_KINDS,
  ProjectGlyph,
  type ProjectGlyphId,
  type ProjectKindId,
  categorizeCatalogType,
} from './new-project-meta.js';

function TypeCard({
  label,
  description,
  active,
  disabled = false,
  badge,
  iconSvg,
  logoUrl,
  glyph,
  index,
  onSelect,
}: {
  label: string;
  description: string;
  active: boolean;
  disabled?: boolean;
  badge?: string;
  iconSvg?: string;
  logoUrl?: string;
  glyph?: ProjectGlyphId;
  index: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      // biome-ignore lint/a11y/useSemanticElements: cards form one visual radio group; native inputs would duplicate the interactive surface.
      role="radio"
      aria-checked={active}
      aria-label={disabled ? `${label} (coming soon)` : label}
      className={`gz-npd-card${active ? ' active' : ''}`}
      disabled={disabled}
      onClick={onSelect}
      style={{ '--card-i': Math.min(index, 11) } as React.CSSProperties}
    >
      <span className="gz-npd-card-mark" aria-hidden="true">
        <CatalogArtwork
          {...(iconSvg ? { iconSvg } : {})}
          {...(logoUrl ? { logoUrl } : {})}
          svgClassName="gz-npd-card-mark-svg"
          fallback={<ProjectGlyph glyph={glyph ?? 'dots'} size={22} />}
        />
      </span>
      <span className="gz-npd-card-name">{label}</span>
      <span className="gz-npd-card-description">{description}</span>
      {badge && (
        <span className="gz-npd-card-badge" aria-hidden="true">
          {badge}
        </span>
      )}
    </button>
  );
}

type EmailProviderId = 'imap' | 'gmail' | 'microsoft365' | 'outlook';
const EMAIL_PROVIDERS: { id: EmailProviderId; label: string }[] = [
  { id: 'imap', label: 'IMAP' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'microsoft365', label: 'Microsoft 365' },
  { id: 'outlook', label: 'Outlook.com' },
];

/** Auto-generated About/Mission for an email project (meets the min lengths). */
function emailProjectCopy(address: string): { about: string; mission: string } {
  const who = address || 'this mailbox';
  return {
    about: `Email workspace for ${who}. Messages are synced here as searchable markdown files so gezellen can triage the inbox, answer questions over your mail, and draft replies for your review.`,
    mission: `Keep ${who} triaged and responsive: surface threads needing a reply, draft responses for approval, and never send without explicit consent.`,
  };
}

const looksLikeEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/**
 * Seed a project type's param object from its schema `default`s so an
 * untouched form still submits sensible values (e.g. language defaults to
 * "Spanish"). Mirrors the craftbook launcher's seeding — without it, an
 * unedited param stays `undefined` and its `{{placeholder}}` would render
 * literally into the type's about/seed files.
 */
function seedParamDefaults(schema: SquisqAnnotatedSchema | undefined): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, { default?: unknown } | undefined>;
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (def && def.default !== undefined) out[key] = def.default;
  }
  return out;
}

function projectNameParamText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeSuggestedProjectName(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

/**
 * Render a project type's explicit name template, falling back to its first
 * one or two scalar params plus the type name for older/custom manifests.
 */
function suggestProjectName(item: CatalogItemSummary, params: Record<string, unknown>): string {
  const manifest = item.manifest;
  if (manifest.kind !== 'project-type') return manifest.name;

  if (manifest.nameTemplate) {
    const rendered = manifest.nameTemplate.replace(
      /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
      (whole, key: string) => projectNameParamText(params[key]) ?? whole,
    );
    if (!rendered.includes('{{')) return normalizeSuggestedProjectName(rendered);
  }

  const schema = manifest.params as SquisqAnnotatedSchema | undefined;
  const schemaKeys = Object.keys(schema?.properties ?? {});
  const keys = schemaKeys.length > 0 ? schemaKeys : Object.keys(params);
  const values = keys
    .map((key) => projectNameParamText(params[key]))
    .filter((value): value is string => value !== null)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 2);
  return normalizeSuggestedProjectName([...values, manifest.name].join(' '));
}

/**
 * Modal for creating a new project. Enforces the same minimums the
 * service's `CreateProjectRequestSchema` does (about ≥60, mission ≥40)
 * client-side so the caller gets inline validation before the submit
 * round-trip. On success, delegates to `onCreated` for page-level
 * reactions (refresh sidebar, promote to selected, etc.).
 */
export function NewProjectDialog({
  open,
  mode,
  onClose,
  onCreated,
}: {
  open: boolean;
  mode: 'crew' | 'solo';
  onClose: () => void;
  onCreated: (created: ProjectDetail) => Promise<void> | void;
}) {
  const showWorkInProgressFeatures = useShowWorkInProgressFeatures();
  const [name, setName] = useState('');
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [kind, setKind] = useState<ProjectKindId>('general');
  const [about, setAbout] = useState('');
  const [mission, setMission] = useState('');
  // Custom project types available from the catalog (excluding `email`, which
  // has its own dedicated kind above). Selecting one takes over the dialog:
  // the type supplies the about/mission, so those fields hide and the type's
  // params form shows instead. See docs/project-types.md.
  const [projectTypes, setProjectTypes] = useState<CatalogItemSummary[]>([]);
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  const [typeParams, setTypeParams] = useState<Record<string, unknown>>({});
  const [projectTypeQuery, setProjectTypeQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<'all' | ProjectTypeCategory>('all');
  const [repoUrl, setRepoUrl] = useState('');
  // Email kind: the address is the project name; provider + IMAP config inline.
  const [emailAddress, setEmailAddress] = useState('');
  const [emailProvider, setEmailProvider] = useState<EmailProviderId>('imap');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('');
  const [imapPass, setImapPass] = useState('');
  const [imapSecure, setImapSecure] = useState(true);
  // Folder kind: an external working directory the gezels operate on.
  const [folderPath, setFolderPath] = useState('');
  const [repoUrlHint, setRepoUrlHint] = useState<{
    message: string;
    fixUrl?: string;
  } | null>(null);
  const [repoPreviewPhase, setRepoPreviewPhase] = useState<'reading' | 'drafting' | null>(null);
  const [githubIdentity, setGitHubIdentity] = useState<GitHubIdentity | null>(null);
  const [githubRepos, setGitHubRepos] = useState<GitHubRepoSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Track which previewed URL last filled the about/mission fields, so
  // a re-blur on the same URL doesn't re-prompt for replacement.
  const lastAutofilledUrl = useRef<string | null>(null);
  // Repo previews include an LLM draft and can take long enough that the
  // user changes their selection while one is still running. Keep the field
  // editable and ignore any result that no longer belongs to the current
  // selection instead of locking the control for the whole round-trip.
  const repoPreviewRequestId = useRef(0);
  const activeRepoPreviewPath = useRef<string | null>(null);
  const repoPreviewAbort = useRef<AbortController | null>(null);
  const latestDraftFields = useRef({ name, nameManuallyEdited, about, mission });
  latestDraftFields.current = { name, nameManuallyEdited, about, mission };
  const githubRepoInputId = useId();

  // Reset form state each time the dialog opens. Stale inputs after a
  // closed-without-submit feel broken.
  useEffect(() => {
    repoPreviewRequestId.current += 1;
    activeRepoPreviewPath.current = null;
    repoPreviewAbort.current?.abort();
    repoPreviewAbort.current = null;
    if (!open) return;
    setName('');
    setNameManuallyEdited(false);
    setKind('general');
    setAbout('');
    setMission('');
    setRepoUrl('');
    setRepoUrlHint(null);
    setRepoPreviewPhase(null);
    setEmailAddress('');
    setEmailProvider('imap');
    setImapHost('');
    setImapPort('');
    setImapPass('');
    setImapSecure(true);
    setFolderPath('');
    setSelectedTypeId(null);
    setTypeParams({});
    setProjectTypeQuery('');
    setActiveCategory('all');
    setError('');
    setBusy(false);
    lastAutofilledUrl.current = null;
  }, [open]);

  // Load the custom project types offered in the gallery, once per open.
  // `email` is excluded — it has its own kind (with mailbox linking) above.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const projectTypesRequest = api.listCatalogItems('project-type');
    const connectorBooksRequest = showWorkInProgressFeatures
      ? Promise.resolve({ items: [] as CatalogItemSummary[] })
      : api.listCatalogItems('craftbook-template');
    void Promise.all([projectTypesRequest, connectorBooksRequest])
      .then(([types, books]) => {
        if (cancelled) return;
        const connectorIds = connectorCraftbookIds(books.items);
        setProjectTypes(
          visibleCatalogItems(types.items, showWorkInProgressFeatures, connectorIds).filter(
            (item) => item.manifest.id !== 'email',
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setProjectTypes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, showWorkInProgressFeatures]);

  useEffect(() => {
    if (!showWorkInProgressFeatures && kind === 'email') setKind('general');
  }, [kind, showWorkInProgressFeatures]);

  // Fetch the user's accessible repos once they're known to be signed
  // in. Drives the datalist suggestions on the GitHub URL field. The
  // service caches for 5 min, so re-opening the dialog is cheap.
  useEffect(() => {
    if (!open || !githubIdentity) {
      setGitHubRepos([]);
      return;
    }
    let cancelled = false;
    void api
      .listGitHubRepos()
      .then((res) => {
        if (cancelled) return;
        setGitHubRepos(res.repos);
      })
      .catch(() => {
        if (!cancelled) setGitHubRepos([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, githubIdentity]);

  const isSolo = mode === 'solo';
  const titleText = isSolo ? 'New Job' : 'New Project';
  const aboutPlaceholder = isSolo
    ? "Describe the job. What do you want done? What's in scope, what's out? The ambachtsman lands on this with no other context."
    : "Who's this project for, what's in scope, what's out. The first thing any gezel joining the project reads.";
  const missionPlaceholder = isSolo
    ? 'Concrete success criteria. What does the finished job look like?'
    : 'Concrete success criteria, usually a bullet list. What does "done" look like?';
  // Folder projects lean on the folder's own files for context, so About is
  // optional here — auto-filled from an AGENTS.md/CLAUDE.md when the folder has one.
  const folderAboutPlaceholder =
    "Optional. Auto-filled from the folder's AGENTS.md or CLAUDE.md if it has one — or add your own notes about what's here.";
  // Show a native-looking example path so Windows users don't assume forward
  // slashes are required — backslash / drive-letter paths work end-to-end.
  const folderPathPlaceholder =
    window.__GEZEL__?.platform === 'win32' ? 'C:\\projects\\mystuff' : '/path/to/folder';

  const cancelRepoPreview = useCallback(() => {
    repoPreviewRequestId.current += 1;
    activeRepoPreviewPath.current = null;
    repoPreviewAbort.current?.abort();
    repoPreviewAbort.current = null;
    setRepoPreviewPhase(null);
  }, []);

  const handleRepoChange = useCallback(
    (next: string) => {
      // A new selection owns the form immediately. Abort the old fetch/draft
      // and ensure even a provider that ignores cancellation cannot apply its
      // eventual result to this repository.
      cancelRepoPreview();
      setRepoUrlHint(null);
      setRepoUrl(next);
    },
    [cancelRepoPreview],
  );

  const handleRepoPreview = useCallback(
    async (requestedPath?: string) => {
      const path = (requestedPath ?? repoUrl).trim();
      if (!path) {
        setRepoUrlHint(null);
        return;
      }
      if (!isLikelyGitHubPath(path)) {
        setRepoUrlHint({
          message: 'Looks incomplete — enter owner/repo (e.g. bendyline/squisq).',
        });
        return;
      }
      if (lastAutofilledUrl.current === path) {
        // Already filled from this exact repo on a prior blur; don't
        // re-prompt or re-call the API.
        setRepoUrlHint(null);
        return;
      }
      if (!githubIdentity) {
        setRepoUrlHint({
          message: 'Sign in to GitHub to auto-fill About and Mission objectives from this repo.',
        });
        return;
      }
      // Refocusing and blurring the same value while its preview is already in
      // flight should not start a duplicate README fetch + LLM draft.
      if (activeRepoPreviewPath.current === path) return;
      setRepoUrlHint(null);
      const requestId = repoPreviewRequestId.current + 1;
      const controller = new AbortController();
      repoPreviewRequestId.current = requestId;
      activeRepoPreviewPath.current = path;
      repoPreviewAbort.current = controller;
      setRepoPreviewPhase('reading');
      try {
        const preview = await api.previewGitHubRepo(toGitHubUrl(path), controller.signal);
        if (repoPreviewRequestId.current !== requestId) return;
        setRepoPreviewPhase('drafting');
        // Fill the (now-above) Name field the moment the repo resolves,
        // before the slower About/Mission draft — so a failed or empty
        // README draft still leaves the project named.
        const currentAfterPreview = latestDraftFields.current;
        if (!currentAfterPreview.nameManuallyEdited) {
          setName(preview.repo);
        }
        const draftName = currentAfterPreview.nameManuallyEdited
          ? currentAfterPreview.name.trim() || preview.repo
          : preview.repo;
        const draft = await api.previewProjectAbout(
          {
            name: draftName,
            repoUrl: preview.canonicalUrl,
            ...(preview.description ? { description: preview.description } : {}),
            ...(preview.topics ? { topics: preview.topics } : {}),
            readme: preview.readme,
          },
          controller.signal,
        );
        if (repoPreviewRequestId.current !== requestId) return;
        const currentAfterDraft = latestDraftFields.current;
        const aboutHasContent = currentAfterDraft.about.trim().length > 0;
        const missionHasContent = currentAfterDraft.mission.trim().length > 0;
        const overwriteOk =
          !aboutHasContent && !missionHasContent
            ? true
            : window.confirm(
                'Replace the current About and Mission objectives with text drafted from this repo?',
              );
        if (overwriteOk) {
          setAbout(draft.about);
          setMission(draft.missionObjectives);
          lastAutofilledUrl.current = path;
        }
      } catch (err) {
        if (repoPreviewRequestId.current !== requestId) return;
        const fixUrl = extractFixUrl(err);
        setRepoUrlHint({
          message: `Couldn't read this repo: ${describeApiError(err)}`,
          ...(fixUrl ? { fixUrl } : {}),
        });
      } finally {
        if (repoPreviewRequestId.current === requestId) {
          activeRepoPreviewPath.current = null;
          repoPreviewAbort.current = null;
          setRepoPreviewPhase(null);
        }
      }
    },
    [repoUrl, githubIdentity],
  );

  // Set the folder path and pull a preview from the service: the basename
  // becomes the suggested Name (unless the user already typed one), and an
  // AGENTS.md / CLAUDE.md / agent.md at the folder root pre-fills About (only
  // when the user hasn't written their own). Falls back to a local basename for
  // the Name if the preview call fails (browser dev with no service reach).
  const applyFolderPath = useCallback(
    async (dir: string) => {
      setFolderPath(dir);
      const trimmed = dir.trim();
      if (!trimmed) return;
      try {
        const preview = await api.previewFolder(trimmed);
        if (preview.name && !nameManuallyEdited) setName(preview.name);
        if (preview.about) setAbout((prev) => (prev.trim() ? prev : (preview.about ?? '')));
      } catch {
        if (!nameManuallyEdited) {
          const base = trimmed
            .replace(/[\\/]+$/, '')
            .split(/[\\/]/)
            .pop();
          if (base) setName(base);
        }
      }
    },
    [nameManuallyEdited],
  );

  const pickFolder = useCallback(async () => {
    const select = window.__GEZEL__?.selectDirectory;
    if (!select) return; // browser dev: user types the path manually
    try {
      const dir = await select({ title: 'Choose a project folder' });
      if (dir) await applyFolderPath(dir);
    } catch {
      /* picker cancelled */
    }
  }, [applyFolderPath]);

  const selectedType = selectedTypeId
    ? (projectTypes.find((t) => t.manifest.id === selectedTypeId) ?? null)
    : null;
  const selectedTypeParams =
    selectedType?.manifest.kind === 'project-type'
      ? (selectedType.manifest.params as SquisqAnnotatedSchema | undefined)
      : undefined;
  const availableProjectKinds = useMemo(
    () => PROJECT_KINDS.filter((item) => showWorkInProgressFeatures || item.id !== 'email'),
    [showWorkInProgressFeatures],
  );
  const normalizedProjectTypeQuery = projectTypeQuery.trim().toLowerCase();
  const filteredProjectKinds = useMemo(() => {
    if (!normalizedProjectTypeQuery) return availableProjectKinds;
    return availableProjectKinds.filter((item) =>
      `${item.label} ${item.description}`.toLowerCase().includes(normalizedProjectTypeQuery),
    );
  }, [availableProjectKinds, normalizedProjectTypeQuery]);
  const filteredProjectTypes = useMemo(() => {
    if (!normalizedProjectTypeQuery) return projectTypes;
    return projectTypes.filter((item) => {
      const manifest = item.manifest;
      return `${manifest.name} ${manifest.description} ${manifest.tags.join(' ')}`
        .toLowerCase()
        .includes(normalizedProjectTypeQuery);
    });
  }, [normalizedProjectTypeQuery, projectTypes]);

  // The gallery groups both type sources under the shared category registry.
  // A category earns a rail entry only when at least one type claims it —
  // new catalog content lights categories up with no dialog changes. An
  // active search overrides the rail filter (results span all categories).
  const searching = normalizedProjectTypeQuery.length > 0;
  const sections = useMemo(
    () =>
      PROJECT_CATEGORIES.map((cat) => ({
        cat,
        builtins: filteredProjectKinds.filter((k) => k.category === cat.id),
        types: filteredProjectTypes.filter((t) => categorizeCatalogType(t) === cat.id),
      })).filter((s) => s.builtins.length + s.types.length > 0),
    [filteredProjectKinds, filteredProjectTypes],
  );
  const visibleSections =
    searching || activeCategory === 'all'
      ? sections
      : sections.filter((s) => s.cat.id === activeCategory);
  const railEntries = useMemo(
    () =>
      PROJECT_CATEGORIES.map((cat) => ({
        cat,
        count:
          availableProjectKinds.filter((k) => k.category === cat.id).length +
          projectTypes.filter((t) => categorizeCatalogType(t) === cat.id).length,
      })).filter((entry) => entry.count > 0),
    [availableProjectKinds, projectTypes],
  );
  const paneSelection: PaneSelection = selectedType
    ? { source: 'catalog', item: selectedType }
    : {
        source: 'builtin',
        kind:
          availableProjectKinds.find((candidate) => candidate.id === kind) ??
          availableProjectKinds[0]!,
      };

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError('');

      // CUSTOM PROJECT TYPE: creation and materialization are one server-owned
      // operation. Nothing becomes visible until the type's crew, scripts,
      // seeded files, toolsets, and project documents have committed.
      if (selectedTypeId && selectedType) {
        const n = name.trim();
        if (!n) {
          setError('Name is required.');
          return;
        }
        setBusy(true);
        try {
          // Merge schema defaults UNDER the user's edits so an untouched
          // param still submits its default — the squisq JsonEditor doesn't
          // seed defaults into its value on mount, so `typeParams` alone can
          // be missing them (which would leave `{{placeholder}}` unrendered).
          const schema =
            selectedType.manifest.kind === 'project-type'
              ? (selectedType.manifest.params as SquisqAnnotatedSchema | undefined)
              : undefined;
          const { project, applied } = await api.createTypedProject({
            name: n,
            ...(isSolo ? { mode: 'solo' as const } : {}),
            projectType: {
              typeId: selectedTypeId,
              params: { ...seedParamDefaults(schema), ...typeParams },
            },
          });
          // Refresh the global roster only after the atomic operation commits.
          // Deliberately omit detail: `gezelsCreated` is only a summary, while
          // listeners that merge event detail expect a full GezelSummary.
          if (applied.gezelsCreated.length > 0) {
            window.dispatchEvent(new CustomEvent('gezel:gezel-updated'));
          }
          await onCreated(project);
          onClose();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
        return;
      }

      // EMAIL: the address is the project name; About/Mission are auto-written.
      if (kind === 'email') {
        const addr = emailAddress.trim();
        if (!looksLikeEmail(addr)) {
          setError('Enter a valid email address — it becomes the project name.');
          return;
        }
        if (emailProvider === 'imap' && (!imapHost.trim() || !imapPass)) {
          setError('IMAP needs at least a host and a password.');
          return;
        }
        setBusy(true);
        try {
          const copy = emailProjectCopy(addr);
          const created = await api.createProject({
            name: addr,
            about: copy.about,
            missionObjectives: copy.mission,
            ...(isSolo ? { mode: 'solo' as const } : {}),
          });
          const typed = await api
            .updateProject(created.id, { projectTypeId: 'email' })
            .catch(() => created);
          if (emailProvider === 'imap') {
            await linkImapMailbox(created.id, {
              address: addr,
              host: imapHost.trim(),
              ...(imapPort.trim() ? { port: Number(imapPort.trim()) } : {}),
              secure: imapSecure,
              pass: imapPass,
              // Non-fatal: the project is created + email-typed; the Mail tab
              // is the recovery surface if linking didn't take.
            }).catch((err: unknown) => console.warn('mail link failed:', err));
          } else {
            // OAuth: run the loopback browser flow via the desktop shell.
            // Non-fatal — when the shell is absent (browser dev) or the user
            // cancels, the project is still created + email-typed and they can
            // retry from the Mail tab.
            await connectMailboxOAuth(created.id, emailProvider, addr).catch((err: unknown) =>
              console.warn('mail OAuth failed:', err),
            );
          }
          await onCreated(typed);
          onClose();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
        return;
      }

      // GENERAL / GITHUB / FOLDER: name + About/Mission required.
      const n = name.trim();
      const a = about.trim();
      const m = mission.trim();
      const repo = repoUrl.trim();
      if (!n) {
        setError('Name is required.');
        return;
      }
      // The "from folder" flow draws its context from the folder's files (an
      // AGENTS.md/CLAUDE.md is auto-read into About), so the About/Mission
      // richness minimums that the blank/GitHub flows enforce are skipped here.
      if (kind !== 'folder') {
        if (!a) {
          setError(
            isSolo
              ? 'Job description is required — what you want done, what is in scope, what is out.'
              : "About is required — who this project is for, what's in scope, what's out.",
          );
          return;
        }
      }
      const wantsGitHub = kind === 'github';
      if (wantsGitHub && repo && !isLikelyGitHubPath(repo)) {
        setError("GitHub repo doesn't look right — leave it blank or use owner/repo.");
        return;
      }
      if (kind === 'folder' && !folderPath.trim()) {
        setError('Choose a folder for this project.');
        return;
      }
      setBusy(true);
      try {
        const created = await api.createProject({
          name: n,
          about: a,
          missionObjectives: m,
          ...(isSolo ? { mode: 'solo' as const } : {}),
          ...(wantsGitHub && repo ? { github: { url: toGitHubUrl(repo) } } : {}),
        });
        let finalProject = created;
        if (kind === 'folder' && folderPath.trim()) {
          finalProject = await api
            .setProjectWorkingDir(created.id, folderPath.trim())
            .catch(() => created);
        }
        await onCreated(finalProject);
        onClose();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [
      name,
      kind,
      about,
      mission,
      repoUrl,
      emailAddress,
      emailProvider,
      imapHost,
      imapPort,
      imapPass,
      imapSecure,
      folderPath,
      selectedTypeId,
      selectedType,
      typeParams,
      isSolo,
      onClose,
      onCreated,
    ],
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="gz-npd">
          <form onSubmit={handleSubmit} style={{ display: 'contents' }}>
            <header className="gz-npd-header">
              <div className="gz-npd-header-copy">
                <Dialog.Title asChild>
                  <h3>{titleText}</h3>
                </Dialog.Title>
                <p className="gz-npd-header-sub">
                  {isSolo
                    ? 'A job is a solo project — the Meester picks one specialist (the ambachtsman) who handles everything themselves.'
                    : 'Pick a starting point — blank, connected, or purpose-built.'}
                </p>
              </div>
              <label className="gz-npd-search">
                <span className="sr-only">Search project types</span>
                <input
                  type="search"
                  value={projectTypeQuery}
                  onChange={(event) => setProjectTypeQuery(event.target.value)}
                  placeholder="Search types…"
                />
              </label>
            </header>
            <div className="gz-npd-body">
              <nav className="gz-npd-rail" aria-label="Project type categories">
                <button
                  type="button"
                  className={`gz-npd-rail-item${!searching && activeCategory === 'all' ? ' active' : ''}`}
                  onClick={() => setActiveCategory('all')}
                >
                  <span className="gz-npd-rail-label">All</span>
                </button>
                {railEntries.map((entry) => (
                  <button
                    key={entry.cat.id}
                    type="button"
                    className={`gz-npd-rail-item${!searching && activeCategory === entry.cat.id ? ' active' : ''}`}
                    onClick={() => setActiveCategory(entry.cat.id)}
                  >
                    <ProjectGlyph glyph={entry.cat.glyph} size={16} />
                    <span className="gz-npd-rail-label">{entry.cat.label}</span>
                    <span className="gz-npd-rail-count">{entry.count}</span>
                  </button>
                ))}
              </nav>
              <div className="gz-npd-gallery" role="radiogroup" aria-label="Project type">
                {visibleSections.map((section) => (
                  <section key={section.cat.id} className="gz-npd-section">
                    <div className="gz-npd-section-head">
                      <span className="gz-npd-section-title">{section.cat.label}</span>
                      <span className="gz-npd-section-tagline">{section.cat.tagline}</span>
                    </div>
                    <div className="gz-npd-grid">
                      {section.builtins.map((item, index) => (
                        <TypeCard
                          key={item.id}
                          label={item.label}
                          description={item.description}
                          glyph={item.glyph}
                          index={index}
                          active={!selectedTypeId && item.id === kind}
                          {...(item.soon ? { disabled: true, badge: 'Soon' } : {})}
                          onSelect={() => {
                            if (item.soon) return;
                            if (kind === 'github' && item.id !== 'github') cancelRepoPreview();
                            setKind(item.id as ProjectKindId);
                            setSelectedTypeId(null);
                            setTypeParams({});
                            if (!nameManuallyEdited) setName('');
                          }}
                        />
                      ))}
                      {section.types.map((item, index) => (
                        <TypeCard
                          key={item.manifest.id}
                          label={item.manifest.name}
                          description={item.manifest.description}
                          glyph={section.cat.glyph}
                          index={section.builtins.length + index}
                          active={item.manifest.id === selectedTypeId}
                          {...(item.iconSvg ? { iconSvg: item.iconSvg } : {})}
                          {...(item.logoUrl ? { logoUrl: item.logoUrl } : {})}
                          onSelect={() => {
                            if (kind === 'github') cancelRepoPreview();
                            setSelectedTypeId(item.manifest.id);
                            // A purpose-built type owns the whole form. Seed
                            // its parameter defaults before showing its editor.
                            setKind('general');
                            const schema =
                              item.manifest.kind === 'project-type'
                                ? (item.manifest.params as SquisqAnnotatedSchema | undefined)
                                : undefined;
                            const defaults = seedParamDefaults(schema);
                            setTypeParams(defaults);
                            if (!nameManuallyEdited) setName(suggestProjectName(item, defaults));
                          }}
                        />
                      ))}
                    </div>
                  </section>
                ))}
                {visibleSections.length === 0 && (
                  <p className="gz-npd-empty">No project types match your search.</p>
                )}
              </div>
              <aside className="gz-npd-pane">
                <div className="gz-npd-pane-scroll" key={selectedTypeId ?? kind}>
                  <NewProjectPaneHero selection={paneSelection} />
                  <div className="gz-npd-pane-form">
                    {selectedType && selectedTypeParams && (
                      <div className="gz-npd-params">
                        <GezelJsonEditor
                          schema={selectedTypeParams}
                          value={typeParams}
                          onChange={(next) => {
                            const nextParams = (next ?? {}) as Record<string, unknown>;
                            setTypeParams(nextParams);
                            if (!nameManuallyEdited) {
                              setName(suggestProjectName(selectedType, nextParams));
                            }
                          }}
                          density="compact"
                        />
                      </div>
                    )}
                    {kind === 'github' && (
                      <div className="gz-npd-field">
                        <span className="gz-new-project-github-label">
                          <label htmlFor={githubRepoInputId}>
                            GitHub repository <span className="muted">(optional)</span>
                          </label>
                          <GitHubSignInChip onChange={setGitHubIdentity} compact />
                        </span>
                        <GitHubRepoCombobox
                          inputId={githubRepoInputId}
                          value={repoUrl}
                          onChange={handleRepoChange}
                          onBlur={() => void handleRepoPreview()}
                          onSelect={(picked) => {
                            handleRepoChange(picked);
                            // Pass the picked value directly: state updates land
                            // on the next render, while the preview should begin
                            // immediately from this selection.
                            void handleRepoPreview(picked);
                          }}
                          repos={githubRepos}
                        />
                        {repoPreviewPhase && (
                          <RepoPreviewProgress
                            phase={repoPreviewPhase}
                            onCancel={cancelRepoPreview}
                          />
                        )}
                        {!repoPreviewPhase && repoUrlHint && (
                          <small className="error">
                            {repoUrlHint.message}
                            {repoUrlHint.fixUrl && (
                              <>
                                {' '}
                                <a
                                  href={repoUrlHint.fixUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  Open GitHub authorization page →
                                </a>
                              </>
                            )}
                          </small>
                        )}
                      </div>
                    )}
                    {/* Folder sits above Name: picking the folder is the first move,
                and it suggests the Name (and drafts About) from what it finds. */}
                    {kind === 'folder' && (
                      <label>
                        Folder
                        <div className="gz-folder-row">
                          <input
                            value={folderPath}
                            onChange={(e) => setFolderPath(e.target.value)}
                            onBlur={() => void applyFolderPath(folderPath)}
                            placeholder={folderPathPlaceholder}
                          />
                          {window.__GEZEL__?.selectDirectory && (
                            <button
                              type="button"
                              className="gz-folder-browse"
                              onClick={() => void pickFolder()}
                            >
                              Browse…
                            </button>
                          )}
                        </div>
                        <small className="muted">
                          Gezels read — and, with permission, write — files in this folder.
                        </small>
                      </label>
                    )}
                    {kind === 'email' ? (
                      <label>
                        Email address
                        <input
                          type="email"
                          value={emailAddress}
                          onChange={(e) => setEmailAddress(e.target.value)}
                          placeholder="you@example.com"
                          autoComplete="email"
                        />
                        <small className="muted">The project is named after this address.</small>
                      </label>
                    ) : (
                      <label>
                        Name
                        <input
                          value={name}
                          onChange={(e) => {
                            setName(e.target.value);
                            setNameManuallyEdited(true);
                          }}
                          placeholder={
                            isSolo ? 'e.g. Bird-feeder prototype' : "e.g. Eliza's Pet Shop"
                          }
                        />
                        {selectedType && name && !nameManuallyEdited && (
                          <small className="muted">
                            Suggested from your choices — edit it anytime.
                          </small>
                        )}
                        {kind === 'folder' && name && !nameManuallyEdited && (
                          <small className="muted">
                            Suggested from the folder — edit it anytime.
                          </small>
                        )}
                      </label>
                    )}
                    {kind === 'email' && (
                      <>
                        <div className="gz-type-field">
                          <span className="gz-type-field-label">Provider</span>
                          <div
                            className="gz-type-picker"
                            role="radiogroup"
                            aria-label="Mail provider"
                          >
                            {EMAIL_PROVIDERS.map((p) => {
                              const active = p.id === emailProvider;
                              return (
                                <button
                                  key={p.id}
                                  type="button"
                                  // biome-ignore lint/a11y/useSemanticElements: chip in a role="radiogroup"; a native radio input would break the chip styling and rich content.
                                  role="radio"
                                  aria-checked={active}
                                  className={`gz-type-chip${active ? ' active' : ''}`}
                                  onClick={() => setEmailProvider(p.id)}
                                >
                                  {p.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        {emailProvider === 'imap' ? (
                          <>
                            <label>
                              IMAP host
                              <input
                                value={imapHost}
                                onChange={(e) => setImapHost(e.target.value)}
                                placeholder="imap.example.com"
                              />
                            </label>
                            <div className="gz-imap-row">
                              <label className="gz-imap-port">
                                Port <span className="muted">(optional)</span>
                                <input
                                  value={imapPort}
                                  onChange={(e) => setImapPort(e.target.value)}
                                  placeholder="993"
                                  inputMode="numeric"
                                />
                              </label>
                              <label className="gz-imap-tls">
                                <input
                                  type="checkbox"
                                  checked={imapSecure}
                                  onChange={(e) => setImapSecure(e.target.checked)}
                                />
                                Use TLS
                              </label>
                            </div>
                            <label>
                              Password / app password
                              <input
                                type="password"
                                value={imapPass}
                                onChange={(e) => setImapPass(e.target.value)}
                                placeholder="app password"
                                autoComplete="off"
                              />
                            </label>
                            <small className="muted">
                              Gmail and Outlook.com also work over IMAP with an app password. The
                              username is your email address.
                            </small>
                          </>
                        ) : (
                          <p className="muted small">
                            {EMAIL_PROVIDERS.find((p) => p.id === emailProvider)?.label} connects
                            via OAuth. Create the project, then click <strong>Connect</strong> in
                            its Mail tab to authorize in the browser. Synced messages become
                            searchable files; sending is consent-gated.
                          </p>
                        )}
                      </>
                    )}
                    {kind !== 'email' && !selectedTypeId && (
                      <>
                        <label>
                          {isSolo ? 'Job description' : 'About'}{' '}
                          <span className="muted">{kind === 'folder' ? '(optional)' : ''}</span>
                          <textarea
                            value={about}
                            onChange={(e) => setAbout(e.target.value)}
                            placeholder={
                              kind === 'folder' ? folderAboutPlaceholder : aboutPlaceholder
                            }
                            rows={4}
                          />
                        </label>
                        <label>
                          Mission objectives <span className="muted">(optional)</span>
                          <textarea
                            value={mission}
                            onChange={(e) => setMission(e.target.value)}
                            placeholder={missionPlaceholder}
                            rows={3}
                          />
                        </label>
                      </>
                    )}
                  </div>
                  {error && <p className="error small">{error}</p>}
                </div>
                <div className="gz-npd-pane-footer">
                  <Dialog.Actions>
                    <button type="button" onClick={onClose} disabled={busy}>
                      Cancel
                    </button>
                    <button type="submit" className="primary" disabled={busy}>
                      {busy ? 'Creating…' : 'Create'}
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

function RepoPreviewProgress({
  phase,
  onCancel,
}: {
  phase: 'reading' | 'drafting';
  onCancel: () => void;
}) {
  // Resolve the Klerk only while this row is visible; a closed dialog or a
  // non-GitHub project should not add config/roster reads to ProjectsView.
  const klerk = useKlerkInfo();
  const klerkName = klerk?.name ?? 'Klerk';
  return (
    <output className="gz-npd-repo-progress" aria-live="polite">
      <GezelIcon
        svg={klerk?.icon}
        poppetje={klerk?.poppetje}
        iconOverride={klerk?.iconOverride}
        name={klerkName}
        size={28}
        pulsing
        title={`${klerkName} is working`}
      />
      <span className="gz-npd-repo-progress-text">
        {phase === 'reading'
          ? `${klerkName} is reading the repository…`
          : `${klerkName} is drafting About and Mission objectives…`}
      </span>
      <button
        type="button"
        className="secondary gz-npd-repo-cancel"
        onClick={(event) => {
          event.preventDefault();
          onCancel();
        }}
      >
        Cancel draft
      </button>
    </output>
  );
}

/**
 * Combobox for the New Project dialog's GitHub URL field. The native
 * `<datalist>` we tried first forces the browser to show the option's
 * value (the URL) on the left of each row; we want `owner/repo —
 * description` only. So this rolls its own tiny dropdown — input still
 * stores the URL, but the displayed suggestions skip the noisy URL
 * prefix.
 *
 * Suggestions surface on focus when the user hasn't typed anything yet,
 * and filter by substring against `fullName` + `description` as they
 * type. Picking one fires `onSelect`, which the caller wires up to also
 * trigger the repo-preview path (same effect as tabbing out of the
 * field).
 */
function GitHubRepoCombobox({
  inputId,
  value,
  onChange,
  onBlur,
  onSelect,
  repos,
  disabled,
}: {
  inputId: string;
  value: string;
  onChange: (next: string) => void;
  onBlur: () => void;
  onSelect: (url: string) => void;
  repos: GitHubRepoSummary[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Filter against the full org/repo and description. Two "show
  // everything" states matter:
  //   - empty input (just focused, hasn't typed anything yet)
  //   - the input exactly matches one of the known repos (the user
  //     already picked one or pasted a known owner/repo — re-opening
  //     should let them switch, not filter down to that single match)
  const filtered = useMemo(() => {
    if (repos.length === 0) return [];
    const q = value.trim().toLowerCase();
    if (!q) return repos;
    if (repos.some((r) => r.fullName.toLowerCase() === q)) return repos;
    return repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.description ? r.description.toLowerCase().includes(q) : false),
    );
  }, [repos, value]);

  // Close when focus leaves the whole control. Using a pointerdown
  // capture on the document would also work but feels heavier — letting
  // the natural blur cascade close it keeps the keyboard flow clean.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const showSuggestions = open && filtered.length > 0;

  return (
    <div className="gz-github-repo-combobox" ref={wrapperRef}>
      <div className="gz-github-repo-input-row">
        <span className="gz-github-repo-prefix" aria-hidden="true">
          github.com/
        </span>
        <input
          id={inputId}
          ref={inputRef}
          value={value}
          onChange={(e) => {
            // The fixed `github.com/` prefix means the field holds a
            // bare owner/repo — strip any scheme + host a user pastes
            // (https://github.com/foo/bar → foo/bar) so it folds in.
            onChange(stripGitHubPrefix(e.target.value));
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Defer the blur callback so a click on a suggestion can
            // land first; the click path calls onSelect, which sets
            // the value before this blur fires.
            window.setTimeout(() => onBlur(), 120);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="owner/repo"
          disabled={disabled}
          autoComplete="off"
        />
        {repos.length > 0 && (
          <button
            type="button"
            className="gz-github-repo-chevron"
            aria-label={open ? 'Hide repo suggestions' : 'Show repo suggestions'}
            aria-expanded={open}
            disabled={disabled}
            // mousedown so the input doesn't blur-close the list
            // before our click handler reopens it.
            onMouseDown={(e) => {
              e.preventDefault();
              setOpen((o) => !o);
              inputRef.current?.focus();
            }}
          >
            <DropdownChevron
              style={{
                transform: open ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.12s',
              }}
            />
          </button>
        )}
      </div>
      {showSuggestions && (
        <ul className="gz-github-repo-suggestions">
          {filtered.map((r) => (
            <li key={r.url}>
              <button
                type="button"
                className="gz-github-repo-suggestion"
                // mousedown (not click) so we fire BEFORE the input's
                // blur removes focus + closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(r.fullName);
                  setOpen(false);
                }}
              >
                <span className="gz-github-repo-suggestion-name">{r.fullName}</span>
                {r.description && (
                  <span className="gz-github-repo-suggestion-desc">{r.description}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Normalize whatever the user types or pastes into the create dialog's
 * GitHub field down to a bare `owner/repo`. The field renders a fixed
 * `github.com/` prefix, so when someone pastes a full URL we strip the
 * scheme + host (`https://github.com/foo/bar` → `foo/bar`) instead of
 * complaining that it "doesn't look like a GitHub URL".
 */
function stripGitHubPrefix(input: string): string {
  return input
    .replace(/^\s*https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^github\.com\//i, '')
    .replace(/^\/+/, '');
}

/** Bare `owner/repo` → the canonical clone URL, or '' when incomplete. */
function toGitHubUrl(path: string): string {
  const slug = stripGitHubPrefix(path)
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return slug ? `https://github.com/${slug}` : '';
}

/**
 * Cheap client-side check before we hit the backend's repo-preview
 * endpoint. The server-side parser ({@link parseGitHubUrl}) is the
 * authority — this just gates the network round-trip + autofill flow.
 * Accepts a bare `owner/repo` (what the prefixed field stores) as well
 * as a full URL, since paste happens before the strip lands.
 */
function isLikelyGitHubPath(input: string): boolean {
  const slug = stripGitHubPrefix(input)
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(slug);
}

/**
 * The bare `error.message` from `GezelApiError` is just the HTTP
 * status line ("Gezel API error 502 on POST …") which is useless to
 * the user. The actual error string from the service lives in
 * `error.details.error`. Surface that when present so "couldn't read
 * this repo" becomes "couldn't read this repo: GitHub returned 403 —
 * the OAuth grant probably lacks…".
 */
function describeApiError(err: unknown): string {
  if (err instanceof GezelApiError) {
    const details = err.details;
    if (details && typeof details === 'object' && 'error' in details) {
      const msg = (details as { error?: unknown }).error;
      if (typeof msg === 'string' && msg.length > 0) return msg;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * If the API returned a `fixUrl` in its error body — currently only
 * the github-repo-preview 403 path does this, when the OAuth App is
 * blocked at the org level — pull it out so the dialog can render a
 * clickable link directly to the GitHub page that resolves it.
 */
function extractFixUrl(err: unknown): string | null {
  if (!(err instanceof GezelApiError)) return null;
  const details = err.details;
  if (details && typeof details === 'object' && 'fixUrl' in details) {
    const url = (details as { fixUrl?: unknown }).fixUrl;
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return null;
}
