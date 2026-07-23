import type {
  CatalogItemSummary,
  CraftbookTemplateManifest,
  CraftbookToolsetNeed,
  DiscoveredCommand,
  DiscoveredSkill,
  PendingImportItem,
  WorkspaceCommandIndex,
} from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Popover } from '../primitives/index.js';
import { CraftbookParamForm } from './CraftbookParamForm.js';
import { CraftbookToolsetSetup } from './CraftbookToolsetSetup.js';
import { craftbookCommandName, renderCraftbookCommand } from './craftbook-command.js';

interface Props {
  projectId: string;
  /**
   * Stage a command string into the project-chat terminal for the user
   * to review + run (the craftbook command launcher). Absent → the
   * launcher is unavailable and clicks show a hint toast.
   */
  onStageCommand?: (command: string) => void;
}

/** A craftbook declares params iff its paramSchema has ≥1 property. */
function craftbookHasParams(m: CraftbookTemplateManifest): boolean {
  const props = (m.paramSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return !!props && Object.keys(props).length > 0;
}

const GROUP_ORDER: Array<{ kind: DiscoveredCommand['kind']; title: string }> = [
  { kind: 'npm-script', title: 'npm scripts' },
  { kind: 'workspace-script', title: 'Scripts folder' },
  { kind: 'vscode-launch', title: 'VSCode launch' },
  { kind: 'bin', title: 'Installed CLIs' },
];

/**
 * Lists every command the indexer discovered in the project's
 * workspace, grouped by source. Click → copy `run` to clipboard.
 *
 * Polls the workspace-index status every 30s; when meta.scannedAt
 * advances, re-fetches the full index. The first mount on a
 * never-indexed project kicks off a forced refresh so the panel
 * doesn't sit empty waiting for the next sweep.
 */
export function CommandsPanel({ projectId, onStageCommand }: Props) {
  const [index, setIndex] = useState<WorkspaceCommandIndex | null>(null);
  const [craftbooks, setCraftbooks] = useState<CatalogItemSummary[]>([]);
  // Craftbook id → required toolsets it declares that aren't installed.
  const [missingToolsets, setMissingToolsets] = useState<Record<string, CraftbookToolsetNeed[]>>(
    {},
  );
  // Resolved project type + the curated suggested-craftbook subset for it.
  const [projectType, setProjectType] = useState<{ id: string; label: string } | null>(null);
  const [suggestedIds, setSuggestedIds] = useState<Set<string>>(new Set());
  // When a type resolves, the rail leads with the suggested subset and hides
  // the rest behind this toggle.
  const [showAllCraftbooks, setShowAllCraftbooks] = useState(false);
  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
  // Bash→JS translations awaiting review before they're written to disk.
  const [pendingImports, setPendingImports] = useState<PendingImportItem[]>([]);
  const [filter, setFilter] = useState('');
  // The craftbook whose param form is currently open (null = none).
  const [paramTarget, setParamTarget] = useState<CraftbookTemplateManifest | null>(null);
  // The craftbook whose toolset-setup popover is open (null = none).
  const [setupTarget, setSetupTarget] = useState<CraftbookTemplateManifest | null>(null);
  const [scannedAt, setScannedAt] = useState<string | undefined>();
  const [state, setState] = useState<'fresh' | 'stale' | 'indexing' | 'never'>('never');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Load the index whenever the on-disk scannedAt advances.
  const loadIndex = useCallback(async () => {
    try {
      const next = await api.getProjectIndex(projectId);
      setIndex(next);
      setError(null);
    } catch (err) {
      // 404 = not yet indexed; let the status poll drive the next attempt.
      const message = err instanceof Error ? err.message : String(err);
      if (!/404|not yet indexed/i.test(message)) {
        setError(message);
      }
    }
    try {
      const skillsRes = await api.getProjectSkills(projectId);
      setSkills(skillsRes.skills);
    } catch {
      /* skills index is optional — silently degrade */
    }
  }, [projectId]);

  // Load the craftbooks APPLICABLE to this project (those whose
  // `requirements` — GitHub-connected, non-main branch, … — are met).
  // Unlike the workspace index, applicability depends on the project's
  // git/GitHub state, which can change (branch switch) without an index
  // scan — so this is re-fetched on the same poll cadence below.
  const loadCraftbooks = useCallback(async () => {
    try {
      const res = await api.listProjectCraftbooks(projectId);
      setCraftbooks(res.items);
      setMissingToolsets(res.missingToolsets ?? {});
      setProjectType(res.projectType ?? null);
      setSuggestedIds(new Set(res.suggestedIds ?? []));
    } catch {
      /* craftbooks are best-effort */
    }
  }, [projectId]);
  // (loaded on mount + every 30s by the status poll below)

  // Drop a command into the terminal input for review. Nothing is fired on
  // click — the user reviews the staged line and presses Enter (craftbooks
  // are recognized server-side → create task + assign + start; scripts run
  // as-is). Shared by craftbooks and workspace commands so both stage the
  // same way when a terminal is wired.
  const stageCommand = useCallback(
    (cmd: string) => {
      onStageCommand?.(cmd);
      setToast(`Staged: ${cmd} — review and press Enter`);
      window.setTimeout(() => setToast(null), 2400);
    },
    [onStageCommand],
  );

  const stageCraftbook = useCallback(
    (cb: CraftbookTemplateManifest, values: Record<string, string>) => {
      if (!onStageCommand) {
        setToast('Open this from a project chat to run craftbooks.');
        window.setTimeout(() => setToast(null), 2400);
        return;
      }
      stageCommand(renderCraftbookCommand(cb, values));
    },
    [onStageCommand, stageCommand],
  );

  // Click: a craftbook with uninstalled required toolsets opens the
  // setup popover first; otherwise param'd craftbooks open the squisq
  // form and parameterless ones stage the bare command.
  const onCraftbookClick = useCallback(
    (cb: CraftbookTemplateManifest) => {
      if ((missingToolsets[cb.id]?.length ?? 0) > 0) {
        setSetupTarget(cb);
        return;
      }
      if (craftbookHasParams(cb)) setParamTarget(cb);
      else stageCraftbook(cb, {});
    },
    [stageCraftbook, missingToolsets],
  );

  // Skill imports that produced a translated script wait here for the
  // user to approve (write craftbook + script) or reject (prose-only).
  const loadPendingImports = useCallback(async () => {
    try {
      const res = await api.getProjectImportsPending(projectId);
      setPendingImports(res.items);
    } catch {
      /* optional — pre-existing projects may have no .gezel/ yet */
    }
  }, [projectId]);

  const reviewImport = useCallback(
    async (skillSource: string, action: 'approve' | 'reject') => {
      try {
        if (action === 'approve') await api.approveProjectImport(projectId, skillSource);
        else await api.rejectProjectImport(projectId, skillSource);
        setPendingImports((p) => p.filter((it) => it.skillSource !== skillSource));
        setToast(action === 'approve' ? 'Imported craftbook + script' : 'Kept as prose-only');
      } catch (err) {
        setToast(`Review failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      window.setTimeout(() => setToast(null), 2400);
    },
    [projectId],
  );

  const invokeSkill = useCallback(
    async (skill: DiscoveredSkill) => {
      try {
        const task = await api.createTask(projectId, {
          title: `${skill.name} (workspace skill) — ${new Date().toLocaleString()}`,
          description:
            skill.description ||
            `Run the workspace skill ${skill.name} (${skill.source}) against this project.`,
          steps: [
            {
              name: skill.name,
              ...(skill.description ? { description: skill.description } : {}),
              prompt: skill.body,
            },
          ],
          assignee: { kind: 'user' },
        });
        setToast(`Invoked skill ${skill.name} — task ${task.ref}`);
      } catch (err) {
        setToast(
          `Couldn’t invoke ${skill.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      window.setTimeout(() => setToast(null), 2400);
    },
    [projectId],
  );

  // Poll status every 30s; refresh the full index on first arrival
  // or whenever scannedAt advances.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      // Re-check craftbook applicability (cheap; reflects branch/GitHub
      // changes that don't trigger a workspace re-scan).
      if (!cancelled) void loadCraftbooks();
      // Surface any new bash→JS import proposals awaiting review.
      if (!cancelled) void loadPendingImports();
      try {
        const status = await api.getProjectIndexStatus(projectId);
        if (cancelled) return;
        setState(status.state);
        const nextScannedAt = status.meta?.scannedAt;
        if (nextScannedAt && nextScannedAt !== scannedAt) {
          setScannedAt(nextScannedAt);
          await loadIndex();
        } else if (status.state === 'never') {
          // Kick off a scan so cold projects don't sit forever.
          await api.refreshProjectIndex(projectId).catch(() => {});
        }
      } catch {
        /* network or service hiccup — try again next tick */
      }
    };
    void tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [projectId, scannedAt, loadIndex, loadCraftbooks, loadPendingImports]);

  const grouped = useMemo(() => {
    if (!index) return [];
    const q = filter.trim().toLowerCase();
    const groups: Array<{
      kind: DiscoveredCommand['kind'];
      title: string;
      items: DiscoveredCommand[];
    }> = [];
    for (const { kind, title } of GROUP_ORDER) {
      const items = index.commands
        .filter((c) => c.kind === kind)
        .filter((c) => {
          if (!q) return true;
          return (
            c.name.toLowerCase().includes(q) ||
            c.run.toLowerCase().includes(q) ||
            (c.description ? c.description.toLowerCase().includes(q) : false)
          );
        });
      if (items.length > 0) groups.push({ kind, title, items });
    }
    return groups;
  }, [index, filter]);

  const onCopy = useCallback(async (run: string) => {
    try {
      await navigator.clipboard.writeText(run);
      setToast(`Copied: ${run}`);
      window.setTimeout(() => setToast(null), 1800);
    } catch {
      setToast('Couldn’t copy — clipboard blocked.');
      window.setTimeout(() => setToast(null), 2400);
    }
  }, []);

  const totalCount = index?.commands.length ?? 0;
  const filteredCraftbooks = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return craftbooks;
    return craftbooks.filter((c) => {
      const m = c.manifest as { id: string; name: string; description: string };
      return (
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q)
      );
    });
  }, [craftbooks, filter]);
  const filteredSkills = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => {
      return (
        s.name.toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [skills, filter]);
  // One craftbook row — shared by the "Suggested" and "All" sections so the
  // toolset-setup / param-form popover wiring lives in exactly one place.
  const renderCraftbookItem = (cb: CatalogItemSummary) => {
    const m = cb.manifest as CraftbookTemplateManifest;
    const missing = missingToolsets[m.id] ?? [];
    const button = (
      <button
        type="button"
        className="commands-panel-item"
        onClick={() => onCraftbookClick(m)}
        title={
          missing.length > 0
            ? `${craftbookCommandName(m)} — needs setup (${missing.length} toolset${missing.length === 1 ? '' : 's'})`
            : `Run ${craftbookCommandName(m)}`
        }
      >
        <span className="commands-panel-item-name">
          {m.name}
          {missing.length > 0 && <span className="commands-panel-badge small"> needs setup</span>}
        </span>
        {m.description && (
          <span className="commands-panel-item-desc muted small">{m.description}</span>
        )}
      </button>
    );
    // Craftbook with uninstalled required toolsets: anchor the setup popover
    // so the user can install them inline, then re-fetch + proceed.
    if (missing.length > 0) {
      return (
        <li key={`craftbook:${m.id}`}>
          <Popover.Root
            open={setupTarget?.id === m.id}
            onOpenChange={(o) => {
              if (!o) setSetupTarget(null);
            }}
          >
            <Popover.Anchor asChild>{button}</Popover.Anchor>
            <Popover.Content side="left" align="start">
              <CraftbookToolsetSetup
                missing={missing}
                onAllInstalled={() => {
                  setSetupTarget(null);
                  void loadCraftbooks();
                  if (craftbookHasParams(m)) setParamTarget(m);
                  else stageCraftbook(m, {});
                }}
                onCancel={() => setSetupTarget(null)}
              />
            </Popover.Content>
          </Popover.Root>
        </li>
      );
    }
    if (!craftbookHasParams(m)) {
      return <li key={`craftbook:${m.id}`}>{button}</li>;
    }
    // Param'd craftbook: anchor a squisq param form popover to the item.
    return (
      <li key={`craftbook:${m.id}`}>
        <Popover.Root
          open={paramTarget?.id === m.id}
          onOpenChange={(o) => {
            if (!o) setParamTarget(null);
          }}
        >
          <Popover.Anchor asChild>{button}</Popover.Anchor>
          <Popover.Content side="left" align="start">
            <CraftbookParamForm
              manifest={m}
              onSubmit={(values) => {
                stageCraftbook(m, values);
                setParamTarget(null);
              }}
              onCancel={() => setParamTarget(null)}
            />
          </Popover.Content>
        </Popover.Root>
      </li>
    );
  };

  // Partition the (filtered) craftbooks into the curated suggested subset and
  // the rest. The two-section "Suggested + Show all" layout only applies when
  // a type resolved, there's something to suggest, and the user isn't
  // searching (a search should scan the whole catalog flat).
  const isSearching = filter.trim().length > 0;
  const suggestedBooks = filteredCraftbooks.filter((cb) =>
    suggestedIds.has((cb.manifest as { id: string }).id),
  );
  const restBooks = filteredCraftbooks.filter(
    (cb) => !suggestedIds.has((cb.manifest as { id: string }).id),
  );
  const useSuggestedLayout = !isSearching && projectType !== null && suggestedBooks.length > 0;

  const showEmpty =
    state !== 'indexing' &&
    index !== null &&
    totalCount === 0 &&
    craftbooks.length === 0 &&
    skills.length === 0;
  const showLoading = state === 'indexing' || (state === 'never' && index === null);

  return (
    <div className="commands-panel">
      <div className="commands-panel-toolbar">
        <input
          className="commands-panel-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          aria-label="Filter commands"
        />
        <span className="commands-panel-state muted small" title={scannedAt ?? ''}>
          {state === 'indexing'
            ? 'indexing…'
            : state === 'never'
              ? 'not indexed'
              : state === 'stale'
                ? 'stale'
                : `${totalCount} cmd${totalCount === 1 ? '' : 's'}`}
        </span>
      </div>
      {error && <p className="commands-panel-error small">{error}</p>}
      {showLoading && (
        <p className="commands-panel-empty muted small">
          Looking through your workspace for commands…
        </p>
      )}
      {showEmpty && (
        <p className="commands-panel-empty muted small">
          No commands found yet. Add a script to <code>package.json</code> or drop a file in
          <code> scripts/</code>.
        </p>
      )}
      {(grouped.length > 0 ||
        filteredCraftbooks.length > 0 ||
        filteredSkills.length > 0 ||
        pendingImports.length > 0) && (
        <div className="commands-panel-groups">
          {pendingImports.length > 0 && (
            <section className="commands-panel-group">
              <h4 className="commands-panel-group-title muted small">
                Imports to review ({pendingImports.length})
              </h4>
              <ul className="commands-panel-list">
                {pendingImports.map((it) => (
                  <li key={`pending:${it.skillSource}`}>
                    <div className="commands-panel-item" title={it.skillSource}>
                      <span className="commands-panel-item-name">{it.craftbook.name}</span>
                      <span className="commands-panel-item-desc muted small">
                        {it.scripts.length} translated script
                        {it.scripts.length === 1 ? '' : 's'} from {it.skillSource}
                      </span>
                      <span className="commands-panel-item-actions">
                        <button
                          type="button"
                          className="commands-panel-mini"
                          onClick={() => void reviewImport(it.skillSource, 'approve')}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="commands-panel-mini"
                          onClick={() => void reviewImport(it.skillSource, 'reject')}
                        >
                          Keep prose
                        </button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {useSuggestedLayout ? (
            <>
              <section className="commands-panel-group">
                <h4 className="commands-panel-group-title muted small">
                  Suggested for {projectType?.label}
                </h4>
                <ul className="commands-panel-list">{suggestedBooks.map(renderCraftbookItem)}</ul>
              </section>
              {restBooks.length > 0 && (
                <section className="commands-panel-group">
                  <button
                    type="button"
                    className="commands-panel-show-all muted small"
                    aria-expanded={showAllCraftbooks}
                    onClick={() => setShowAllCraftbooks((v) => !v)}
                  >
                    {showAllCraftbooks
                      ? 'Show fewer craftbooks'
                      : `Show all ${filteredCraftbooks.length} craftbooks`}
                  </button>
                  {showAllCraftbooks && (
                    <ul className="commands-panel-list">{restBooks.map(renderCraftbookItem)}</ul>
                  )}
                </section>
              )}
            </>
          ) : (
            filteredCraftbooks.length > 0 && (
              <section className="commands-panel-group">
                <h4 className="commands-panel-group-title muted small">Craftbooks</h4>
                <ul className="commands-panel-list">
                  {filteredCraftbooks.map(renderCraftbookItem)}
                </ul>
              </section>
            )
          )}
          {filteredSkills.length > 0 && (
            <section className="commands-panel-group">
              <h4 className="commands-panel-group-title muted small">Skills (workspace)</h4>
              <ul className="commands-panel-list">
                {filteredSkills.map((skill) => (
                  <li key={`skill:${skill.source}`}>
                    <button
                      type="button"
                      className="commands-panel-item"
                      onClick={() => void invokeSkill(skill)}
                      title={skill.source}
                    >
                      <span className="commands-panel-item-name">{skill.name}</span>
                      {skill.description && (
                        <span className="commands-panel-item-desc muted small">
                          {skill.description}
                        </span>
                      )}
                      {skill.hasShellScripts && (
                        <span className="commands-panel-item-desc muted small">
                          (shell scripts present — prose-only invocation)
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {grouped.map((group) => (
            <section key={group.kind} className="commands-panel-group">
              <h4 className="commands-panel-group-title muted small">{group.title}</h4>
              <ul className="commands-panel-list">
                {group.items.map((cmd) => (
                  <li key={`${cmd.kind}:${cmd.name}:${cmd.source}`}>
                    <button
                      type="button"
                      className="commands-panel-item"
                      onClick={() =>
                        onStageCommand ? stageCommand(cmd.run) : void onCopy(cmd.run)
                      }
                      title={onStageCommand ? `Stage: ${cmd.run}` : `Copy: ${cmd.run}`}
                    >
                      <span className="commands-panel-item-name">{cmd.name}</span>
                      {cmd.description && (
                        <span className="commands-panel-item-desc muted small">
                          {cmd.description}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {toast && <output className="commands-panel-toast">{toast}</output>}
    </div>
  );
}
