import type { CraftbookSummary, NewCraftbookStep } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';
import { CraftbookEditor } from './CraftbookEditor.js';

type Source = 'bundled' | 'local' | 'project';
interface Selection {
  id: string;
  source: Source;
}

const SOURCE_GROUPS: Array<{ source: Source; label: string; hint: string }> = [
  { source: 'local', label: 'My craftbooks', hint: 'editable' },
  { source: 'project', label: 'Project', hint: 'read-only' },
  { source: 'bundled', label: 'Gilde catalog', hint: 'read-only — copy to edit' },
];

export function CraftbooksView() {
  const [craftbooks, setCraftbooks] = useState<CraftbookSummary[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listCraftbooks({ source: 'all' });
      setCraftbooks(res.craftbooks);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return craftbooks;
    return craftbooks.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q),
    );
  }, [craftbooks, query]);

  const open = useCallback((id: string, source: Source) => {
    setCreating(false);
    setSelected({ id, source });
  }, []);

  // Land on a craftbook instead of an empty editor pane: prefer the user's
  // own books, then the catalog, in list order. Never stomps an existing
  // selection.
  useEffect(() => {
    if (selected || craftbooks.length === 0) return;
    const first =
      SOURCE_GROUPS.map((g) => craftbooks.find((c) => c.source === g.source)).find(Boolean) ??
      craftbooks[0];
    if (first) setSelected({ id: first.id, source: first.source });
  }, [selected, craftbooks]);

  const onCreated = useCallback(
    async (id: string) => {
      setCreating(false);
      await refresh();
      open(id, 'local');
    },
    [refresh, open],
  );

  // Craftbooks the "based on existing" picker can clone from: everything we
  // can fully hydrate via getCraftbook (bundled/local/project all qualify).
  const cloneSources = useMemo(
    () => [...craftbooks].sort((a, b) => a.name.localeCompare(b.name)),
    [craftbooks],
  );

  return (
    <div className="tasks-view craftbooks-view" data-testid="craftbooks-view">
      <div className="tasks-layout craftbooks-layout">
        <aside className="craftbooks-sidebar" aria-label="Craftbook library">
          <div className="craftbooks-toolbar">
            <label className="craftbooks-search-field">
              <span className="sr-only">Search craftbooks</span>
              <input
                type="search"
                className="craftbook-search"
                placeholder="Search craftbooks…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              + New craftbook
            </button>
          </div>

          {error && <p className="error craftbooks-list-error">{error}</p>}

          <div className="tasks-list craftbooks-list">
            {SOURCE_GROUPS.map((group) => {
              const items = filtered.filter((c) => c.source === group.source);
              if (items.length === 0) return null;
              return (
                <div key={group.source} className="craftbook-group">
                  <div className="craftbook-group-header small muted">
                    {group.label} <span className="craftbook-group-hint">· {group.hint}</span>
                  </div>
                  <ul>
                    {items.map((c) => (
                      <li key={`${c.source}:${c.id}`}>
                        <button
                          type="button"
                          className={`task-row${
                            selected?.id === c.id && selected?.source === c.source
                              ? ' task-row-selected'
                              : ''
                          }`}
                          onClick={() => open(c.id, c.source)}
                        >
                          <span className="task-row-body">
                            <span className="task-title">{c.name}</span>
                            <span className="task-row-meta">
                              <span className="task-ref">{c.id}</span>
                              <span className="task-assignee">
                                {c.stepCount} step{c.stepCount === 1 ? '' : 's'}
                              </span>
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="muted craftbooks-empty">
                No craftbooks{query ? ' match your search' : ' yet'}.
              </p>
            )}
          </div>
        </aside>

        <section className="task-detail-panel craftbooks-detail" aria-label="Craftbook editor">
          {selected ? (
            <CraftbookEditor
              key={`${selected.source}:${selected.id}`}
              craftbookId={selected.id}
              source={selected.source}
              onChanged={() => void refresh()}
            />
          ) : (
            <p className="placeholder">
              Select a craftbook to edit it, or start a new one. Gilde books open read-only — make a
              copy to edit them.
            </p>
          )}
        </section>
      </div>

      <NewCraftbookDialog
        open={creating}
        cloneSources={cloneSources}
        onClose={() => setCreating(false)}
        onCreated={onCreated}
      />
    </div>
  );
}

type CreateMode = 'blank' | 'existing';

function NewCraftbookDialog({
  open,
  cloneSources,
  onClose,
  onCreated,
}: {
  open: boolean;
  cloneSources: CraftbookSummary[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [mode, setMode] = useState<CreateMode>('blank');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [stepNames, setStepNames] = useState('Build\nReview');
  const [baseQuery, setBaseQuery] = useState('');
  const [base, setBase] = useState<CraftbookSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset every time the dialog opens so it never reopens half-filled.
  useEffect(() => {
    if (!open) return;
    setMode('blank');
    setName('');
    setNameTouched(false);
    setDescription('');
    setStepNames('Build\nReview');
    setBaseQuery('');
    setBase(null);
    setBusy(false);
    setError(null);
  }, [open]);

  const filteredBases = useMemo(() => {
    const q = baseQuery.trim().toLowerCase();
    if (!q) return cloneSources;
    return cloneSources.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q),
    );
  }, [cloneSources, baseQuery]);

  const pickBase = (c: CraftbookSummary) => {
    setBase(c);
    // Prefill a sensible copy name unless the user has already typed one.
    if (!nameTouched) setName(`${c.name} copy`);
  };

  const canSubmit = !busy && name.trim().length > 0 && (mode === 'blank' || base !== null);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let body: Parameters<typeof api.createCraftbook>[0];
      if (mode === 'existing') {
        if (!base) {
          setError('Pick a craftbook to base this on.');
          setBusy(false);
          return;
        }
        const { craftbook: src } = await api.getCraftbook(base.id, { source: base.source });
        const steps: NewCraftbookStep[] = src.steps.map((s) => ({ ...s }));
        body = {
          name: name.trim(),
          // Default the new book's description to the source's; let the user override.
          ...(description.trim()
            ? { description: description.trim() }
            : src.description
              ? { description: src.description }
              : {}),
          steps,
          entryStepId: src.entryStepId,
          ...(src.plan ? { plan: src.plan } : {}),
          ...(src.defaultAssignee ? { defaultAssignee: src.defaultAssignee } : {}),
          ...(src.paramSchema ? { paramSchema: src.paramSchema } : {}),
          ...(src.requirements ? { requirements: src.requirements } : {}),
          ...(src.recommends ? { recommends: src.recommends } : {}),
          ...(src.toolsets ? { toolsets: src.toolsets } : {}),
          // Intentionally omit `command` — a clone must not claim the source's
          // command token; the user can set one after.
        };
      } else {
        const steps: NewCraftbookStep[] = stepNames
          .split(/\n|,/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((n) => ({ name: n }));
        if (steps.length === 0) {
          setError('A craftbook needs at least one step.');
          setBusy(false);
          return;
        }
        body = {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          steps,
        };
      }
      const res = await api.createCraftbook(body);
      onCreated(res.craftbook.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="new-craftbook-dialog">
          <Dialog.Title asChild>
            <h3>New craftbook</h3>
          </Dialog.Title>

          <div
            className="new-craftbook-modes"
            role="radiogroup"
            aria-label="How to start the craftbook"
          >
            <button
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of card buttons; a native <input type="radio"> can't host the strong+span card layout
              role="radio"
              aria-checked={mode === 'blank'}
              className={`new-craftbook-mode${mode === 'blank' ? ' active' : ''}`}
              onClick={() => setMode('blank')}
              disabled={busy}
            >
              <strong>Blank</strong>
              <span className="muted small">Start from a fresh list of steps.</span>
            </button>
            <button
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of card buttons; a native <input type="radio"> can't host the strong+span card layout
              role="radio"
              aria-checked={mode === 'existing'}
              className={`new-craftbook-mode${mode === 'existing' ? ' active' : ''}`}
              onClick={() => setMode('existing')}
              disabled={busy}
            >
              <strong>Based on existing</strong>
              <span className="muted small">Copy another craftbook's steps, then edit.</span>
            </button>
          </div>

          {mode === 'existing' && (
            <div className="new-craftbook-picker">
              <span className="new-craftbook-field-label">Base craftbook</span>
              <input
                type="text"
                className="craftbook-search"
                placeholder="Search craftbooks…"
                value={baseQuery}
                onChange={(e) => setBaseQuery(e.target.value)}
                disabled={busy}
              />
              <ul className="new-craftbook-picker-list" aria-label="Pick a craftbook to copy">
                {filteredBases.map((c) => (
                  <li key={`${c.source}:${c.id}`}>
                    <button
                      type="button"
                      aria-pressed={base?.id === c.id && base?.source === c.source}
                      className={`new-craftbook-picker-row${
                        base?.id === c.id && base?.source === c.source ? ' active' : ''
                      }`}
                      onClick={() => pickBase(c)}
                      disabled={busy}
                    >
                      <span className="new-craftbook-picker-name">{c.name}</span>
                      <span className="muted small">
                        {c.source} · {c.stepCount} step{c.stepCount === 1 ? '' : 's'}
                      </span>
                    </button>
                  </li>
                ))}
                {filteredBases.length === 0 && (
                  <li className="muted small new-craftbook-picker-empty">No craftbooks match.</li>
                )}
              </ul>
            </div>
          )}

          <label>
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              disabled={busy}
            />
          </label>
          <label>
            Description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={
                mode === 'existing'
                  ? "Leave blank to keep the original's description."
                  : 'What this craftbook is for.'
              }
              disabled={busy}
            />
          </label>
          {mode === 'blank' && (
            <label>
              Steps (one per line)
              <textarea
                value={stepNames}
                onChange={(e) => setStepNames(e.target.value)}
                rows={4}
                disabled={busy}
              />
            </label>
          )}

          {error && <p className="gz-dialog-error">{error}</p>}

          <Dialog.Actions>
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
