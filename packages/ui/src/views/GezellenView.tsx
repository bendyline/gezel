import type { GezelDetail, GezelGender, GezelSummary } from '@bendyline/gezel';
import { pickRandomNameWithGender, pronounsForGender } from '@bendyline/gezel';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { CatalogBrowser } from '../components/CatalogBrowser.js';
import { GezelActionsMenu } from '../components/GezelActionsMenu.js';
import { GezelIcon } from '../components/GezelIcon.js';
import { LevelBadge } from '../components/LevelBadge.js';
import { consumeCreate } from '../components/nav-intents.js';
import { Dialog, Tabs } from '../primitives/index.js';
import { GezelDetail as GezelDetailView } from './GezelDetail.js';

type NewGezelTab = 'scratch' | 'template';

export function GezellenView() {
  const [agents, setAgents] = useState<GezelSummary[]>([]);
  const [meesterId, setMeesterId] = useState<string | undefined>(undefined);
  const [selectedGezelId, setSelectedGezelId] = useState<string | undefined>(undefined);
  // Consume a pending "+" intent from the sidebar synchronously on first
  // render (covers the just-opened case; the event below covers the
  // already-mounted case).
  const [showCreate, setShowCreate] = useState(() => consumeCreate('gezel'));
  const [error, setError] = useState<string | null>(null);
  const [generatingIcons, setGeneratingIcons] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const { gezels } = await api.listGezels();
      setAgents(gezels);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshMeester = useCallback(async () => {
    try {
      const config = await api.getConfig();
      setMeesterId(config.meesterGezelId);
    } catch {
      /* keep the last known badge while the service is unavailable */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshMeester();
  }, [refresh, refreshMeester]);

  // Default-select the first gezel once the listing arrives so the
  // detail pane has something to show. If the previously-selected
  // gezel disappears (deleted), fall through to the new first.
  // Read the current selection via the functional updater rather than a
  // render-snapshot dependency: this effect is scheduled when `agents`
  // change but may flush *after* a click has already moved the selection,
  // and a stale snapshot would clobber that fresh pick back to agents[0].
  useEffect(() => {
    if (agents.length === 0) {
      setSelectedGezelId(undefined);
      return;
    }
    setSelectedGezelId((cur) => (cur && agents.some((g) => g.id === cur) ? cur : agents[0]!.id));
  }, [agents]);

  // Detail panes broadcast `gezel:gezel-updated` after a rename / settings
  // change / about save; level-up SSE events arrive as
  // `gezel:growth-updated`. Deletions can originate from this rail, the
  // detail header, or the global sidebar, so remove that gezel optimistically
  // before reconciling with the service. This also unmounts a deleted detail
  // pane immediately instead of leaving it selected during the refresh.
  useEffect(() => {
    const onUpdated = () => void refresh();
    const onDeleted = (event: Event) => {
      const gezelId = (event as CustomEvent<{ gezelId?: string }>).detail?.gezelId;
      if (gezelId) {
        setAgents((current) => current.filter((gezel) => gezel.id !== gezelId));
        setSelectedGezelId((current) => (current === gezelId ? undefined : current));
        setGeneratingIcons((current) => {
          if (!current.has(gezelId)) return current;
          const next = new Set(current);
          next.delete(gezelId);
          return next;
        });
      }
      void refresh();
      void refreshMeester();
    };
    window.addEventListener('gezel:gezel-updated', onUpdated);
    window.addEventListener('gezel:growth-updated', onUpdated);
    window.addEventListener('gezel:gezel-deleted', onDeleted);
    return () => {
      window.removeEventListener('gezel:gezel-updated', onUpdated);
      window.removeEventListener('gezel:growth-updated', onUpdated);
      window.removeEventListener('gezel:gezel-deleted', onDeleted);
    };
  }, [refresh, refreshMeester]);

  // Already-mounted case: a "+" click while this view is open arrives as
  // an event (the lazy initializer above only runs on a fresh mount).
  useEffect(() => {
    const onNew = () => {
      consumeCreate('gezel');
      setShowCreate(true);
    };
    window.addEventListener('gezel:new-gezel', onNew);
    return () => window.removeEventListener('gezel:new-gezel', onNew);
  }, []);

  const markGenerating = useCallback((id: string, on: boolean) => {
    setGeneratingIcons((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const selectGezel = useCallback((id: string) => {
    setSelectedGezelId(id);
  }, []);

  const kickOffBackgroundGeneration = useCallback(
    (gezel: GezelDetail, iconPrompt: string) => {
      // Icon generation runs in the background; the detail tab (and the
      // sidebar row) pick up the new icon via `gezel:gezel-updated`.
      markGenerating(gezel.id, true);
      void (async () => {
        try {
          const updated = await api.generateGezelIcon(
            gezel.id,
            iconPrompt ? { instruction: iconPrompt } : {},
          );
          window.dispatchEvent(new CustomEvent('gezel:gezel-updated', { detail: updated }));
        } catch {
          /* surface in detail; listing just won't update icon */
        } finally {
          markGenerating(gezel.id, false);
        }
      })();
      if (gezel.role) {
        void (async () => {
          try {
            const updated = await api.generateGezelAbout(gezel.id, { role: gezel.role });
            window.dispatchEvent(new CustomEvent('gezel:gezel-updated', { detail: updated }));
          } catch {
            /* same — surfaces in detail */
          }
        })();
      }
    },
    [markGenerating],
  );

  const handleCreate = useCallback(
    async (name: string, role: string, gender: GezelGender, iconPrompt: string) => {
      const created = await api.createGezel({
        name,
        gender,
        ...(role ? { role } : {}),
      });
      setShowCreate(false);
      await refresh();
      selectGezel(created.id);
      // Announce the new gezel right away so the sidebar (and any other
      // listing) folds it in immediately. The later `gezel:gezel-updated`
      // from icon/about generation is best-effort and may never land when
      // those background jobs are slow or unavailable, so it can't be the
      // signal the listing depends on to first show the gezel.
      window.dispatchEvent(new CustomEvent('gezel:gezel-updated', { detail: created }));
      kickOffBackgroundGeneration(created, iconPrompt);
    },
    [refresh, selectGezel, kickOffBackgroundGeneration],
  );

  return (
    <div className="two-col" data-testid="gezels-view">
      <NewGezelDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
        onTemplateCreated={async (gezel) => {
          setShowCreate(false);
          await refresh();
          selectGezel(gezel.id);
          // Same as the scratch path: surface the new gezel in the sidebar
          // immediately rather than waiting on a later best-effort event.
          window.dispatchEvent(new CustomEvent('gezel:gezel-updated', { detail: gezel }));
        }}
      />
      <aside className="side">
        <div className="area-toolbar">
          <button type="button" className="area-toolbar-btn" onClick={() => setShowCreate(true)}>
            + New Gezel
          </button>
        </div>
        <ul className="gezel-list">
          {agents.map((a) => {
            const isGenerating = generatingIcons.has(a.id);
            const isActive = a.id === selectedGezelId;
            return (
              <li key={a.id} className={`gezel-row-shell${isActive ? ' active' : ''}`}>
                <button
                  type="button"
                  className={`gezel-row${isActive ? ' active' : ''}`}
                  onClick={() => selectGezel(a.id)}
                >
                  <GezelIcon
                    svg={a.icon ?? null}
                    poppetje={a.poppetje}
                    iconOverride={a.iconOverride}
                    name={a.name}
                    size={36}
                    pulsing={isGenerating && !a.icon && !a.poppetje}
                  />
                  <span className="gezel-row-text">
                    <span className="gezel-row-name">
                      {a.name}
                      {a.growth && (
                        <LevelBadge level={a.growth.level} pending={!!a.growth.pending} />
                      )}
                      {a.id === meesterId && (
                        <span
                          className="meester-badge"
                          title="Current Meester — change in Settings"
                          aria-label="Current Meester"
                        >
                          ⭐
                        </span>
                      )}
                      {a.fixedFunction && (
                        <span
                          className="ff-row-badge"
                          title={`Fixed-function gezel — forwards messages to ${a.fixedFunction.tool} (no LLM)`}
                          aria-label="Fixed-function gezel"
                        >
                          ⚡
                        </span>
                      )}
                    </span>
                    {a.role && <span className="gezel-row-role">{a.role}</span>}
                  </span>
                </button>
                <GezelActionsMenu gezel={a} compact />
              </li>
            );
          })}
        </ul>
        {error && <p className="error">{error}</p>}
      </aside>
      <section>
        {selectedGezelId ? (
          <GezelDetailView key={selectedGezelId} gezelId={selectedGezelId} />
        ) : (
          <p className="placeholder">No gezellen yet — create one to get started.</p>
        )}
      </section>
    </div>
  );
}

function NewGezelDialog({
  open,
  onClose,
  onCreate,
  onTemplateCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, role: string, gender: GezelGender, iconPrompt: string) => void;
  onTemplateCreated: (gezel: GezelDetail) => void;
}) {
  const [tab, setTab] = useState<NewGezelTab>('scratch');
  // Lifted from TemplateTab so the dialog's onOpenChange can refuse to
  // close mid-create — the catalog call can take a few seconds and we
  // don't want a stray Escape/overlay-click to drop the in-flight request.
  const [templateBusy, setTemplateBusy] = useState(false);

  useEffect(() => {
    if (open) setTab('scratch');
  }, [open]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !templateBusy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="new-gezel-dialog">
          <Dialog.Title asChild>
            <h3 style={{ margin: 0 }}>New Gezel</h3>
          </Dialog.Title>
          <Tabs.Root value={tab} onValueChange={(v) => setTab(v as NewGezelTab)}>
            <Tabs.List>
              <Tabs.Trigger value="scratch">From scratch</Tabs.Trigger>
              <Tabs.Trigger value="template">From template</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="scratch">
              <ScratchTab onCancel={onClose} onCreate={onCreate} />
            </Tabs.Content>
            <Tabs.Content value="template">
              <TemplateTab
                busy={templateBusy}
                setBusy={setTemplateBusy}
                onCancel={onClose}
                onCreated={onTemplateCreated}
              />
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ScratchTab({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (name: string, role: string, gender: GezelGender, iconPrompt: string) => void;
}) {
  const [{ name, gender }, setNameAndGender] = useState(pickRandomNameWithGender);
  const [role, setRole] = useState('');
  const [iconPrompt, setIconPrompt] = useState('');

  const reroll = () => setNameAndGender(pickRandomNameWithGender());

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate(name.trim(), role.trim(), gender, iconPrompt.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="new-gezel-form">
      <label>
        Name
        <div className="name-row">
          <input
            value={name}
            onChange={(e) => setNameAndGender((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="e.g. Ada"
          />
          <button
            type="button"
            className="dice-btn"
            onClick={reroll}
            title="Pick a random name"
            aria-label="Pick a random name"
          >
            🎲
          </button>
        </div>
      </label>
      <label>
        Gender
        <select
          value={gender}
          onChange={(e) =>
            setNameAndGender((prev) => ({ ...prev, gender: e.target.value as GezelGender }))
          }
        >
          <option value="male">male ({pronounsForGender('male')})</option>
          <option value="female">female ({pronounsForGender('female')})</option>
          <option value="non-binary">non-binary ({pronounsForGender('non-binary')})</option>
        </select>
      </label>
      <label>
        Role
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="e.g. Developer, Marketing"
        />
      </label>
      <label>
        Describe the icon <span className="muted">(optional)</span>
        <textarea
          value={iconPrompt}
          onChange={(e) => setIconPrompt(e.target.value)}
          placeholder="e.g. a playful owl wearing glasses, warm colors"
          rows={3}
        />
      </label>
      <Dialog.Actions>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!name.trim()}>
          Create
        </button>
      </Dialog.Actions>
    </form>
  );
}

function TemplateTab({
  busy,
  setBusy,
  onCancel,
  onCreated,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  onCancel: () => void;
  onCreated: (gezel: GezelDetail) => void;
}) {
  const [picked, setPicked] = useState<{
    id: string;
    defaultName: string;
    /** Name suggestions from the template manifest, when present. */
    nameSuggestions: string[];
    /** True when the template carries a `frontmatter.fixedFunction` block. */
    isFixedFunction: boolean;
  } | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!picked || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createGezelFromTemplate(picked.id, {
        name: name.trim(),
      });
      onCreated(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="new-gezel-template-tab">
      <Dialog.Description className="muted small" style={{ margin: '0 0 0.5rem 0' }}>
        Pick a role to start from. The template's about.md becomes the new gezel's prompt — you can
        edit it after.
      </Dialog.Description>
      {error && <p className="error">{error}</p>}
      <CatalogBrowser
        kind="gezel-template"
        emptyMessage="No gezel templates available."
        action={(item) => {
          if (item.manifest.kind !== 'gezel-template') return null;
          const m = item.manifest as TemplateManifestExt;
          const isPicked = picked?.id === m.id;
          const suggestions = Array.isArray(m.nameSuggestions) ? m.nameSuggestions : [];
          const fixedFunction = isFixedFunctionFrontmatter(m.frontmatter);
          return (
            <div className="template-action-stack">
              {fixedFunction && (
                <span
                  className="gz-badge gz-badge-passthrough"
                  title="No LLM — passes your message straight to the configured tool"
                >
                  No LLM — passthrough
                </span>
              )}
              <button
                type="button"
                disabled={busy}
                className={isPicked ? 'primary' : ''}
                onClick={() => {
                  setPicked({
                    id: m.id,
                    defaultName: m.name,
                    nameSuggestions: suggestions,
                    isFixedFunction: fixedFunction,
                  });
                  // Templates with curated name suggestions (the
                  // image-generator's "Picasso", "Vermeer", …) seed
                  // the input with a random pick — the user can
                  // accept, retype, or click another chip below.
                  // Templates without suggestions fall back to the
                  // template's display name (existing behavior).
                  if (suggestions.length > 0) {
                    const idx = Math.floor(Math.random() * suggestions.length);
                    setName(suggestions[idx] ?? m.name);
                  } else {
                    setName(m.name);
                  }
                }}
              >
                {isPicked ? '✓ Selected' : 'Use this template'}
              </button>
            </div>
          );
        }}
      />
      {picked && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="new-gezel-template-form"
        >
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span className="muted small" style={{ flexShrink: 0 }}>
              Name your {picked.defaultName.toLowerCase()}:
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              style={{ flex: 1 }}
            />
          </div>
          {picked.nameSuggestions.length > 0 && (
            <div className="name-suggestions">
              <span className="muted small">Suggestions:</span>
              {picked.nameSuggestions.map((s) => (
                <button
                  type="button"
                  key={s}
                  className={s === name ? 'name-chip name-chip-active' : 'name-chip'}
                  onClick={() => setName(s)}
                  disabled={busy}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <Dialog.Actions>
            <button type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create'}
            </button>
          </Dialog.Actions>
        </form>
      )}
      {!picked && (
        <Dialog.Actions>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </Dialog.Actions>
      )}
    </div>
  );
}

/**
 * Loose shape for a gezel-template manifest extended with the v1
 * fixed-function fields. Mirrors the catalog package's
 * `GezelTemplateManifestSchema` extras (`frontmatter`,
 * `nameSuggestions`) — typed as `unknown` because the catalog kept
 * `frontmatter` schema-loose so the gezel-frontmatter shape can
 * evolve without rev'ing the catalog package.
 */
type TemplateManifestExt = Extract<
  Parameters<NonNullable<Parameters<typeof CatalogBrowser>[0]['action']>>[0]['manifest'],
  { kind: 'gezel-template' }
> & {
  frontmatter?: unknown;
  nameSuggestions?: string[];
};

/**
 * Detect a fixed-function template by sniffing for `fixedFunction`
 * in the manifest's frontmatter extension. Used to render the "No
 * LLM — passthrough" badge in the gilde browser without forcing
 * every template summary through a strong cast.
 */
function isFixedFunctionFrontmatter(raw: unknown): boolean {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      'fixedFunction' in (raw as Record<string, unknown>) &&
      (raw as Record<string, unknown>).fixedFunction,
  );
}
