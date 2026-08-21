import type { CatalogItemDetail, CraftbookToolsetNeed, ToolsetManifest } from '@bendyline/gezel';
import { useState } from 'react';
import { api } from '../api.js';
import { ToolsetConfigForm, type ToolsetConfigFormValue } from './ToolsetConfigForm.js';

interface Props {
  /** The required toolsets a craftbook declares that aren't installed yet. */
  missing: CraftbookToolsetNeed[];
  /** Called once every listed toolset has been installed. */
  onAllInstalled: () => void;
  onCancel: () => void;
}

/**
 * Inline "needs setup" flow for a craftbook's missing required toolsets.
 * Each toolset is installed into the `shared` scope (the scope the
 * launcher's missing-check reads). Toolsets with config fields collect
 * `values` + `secrets` once via the same {@link ToolsetConfigForm} the
 * toolset settings surface uses; field-less toolsets install in one
 * click. When the last one lands, `onAllInstalled` fires so the caller
 * can re-fetch and proceed to invoke the craftbook.
 */
export function CraftbookToolsetSetup({ missing, onAllInstalled, onCancel }: Props) {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The toolset currently collecting config before install (null = none).
  const [configTarget, setConfigTarget] = useState<ToolsetManifest | null>(null);

  const markInstalled = (id: string) => {
    const next = new Set(installed);
    next.add(id);
    setInstalled(next);
    if (missing.every((m) => next.has(m.toolsetId))) onAllInstalled();
  };

  const beginInstall = async (toolsetId: string, sourceId?: string, version?: string) => {
    setBusy(toolsetId);
    setError(null);
    try {
      const detail = (await api.getCatalogItem('toolset', toolsetId, {
        ...(sourceId ? { source: sourceId } : {}),
        ...(version ? { version } : {}),
      })) as CatalogItemDetail;
      if (detail.manifest.kind !== 'toolset') throw new Error('catalog item is not a toolset');
      const manifest = detail.manifest as ToolsetManifest;
      if ((manifest.config ?? []).length === 0) {
        await api.installToolset(toolsetId, {
          scope: { kind: 'shared' },
          ...(version ? { version } : {}),
        });
        markInstalled(toolsetId);
      } else {
        setConfigTarget(manifest);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const completeInstall = async (value: ToolsetConfigFormValue) => {
    if (!configTarget) return;
    const id = configTarget.id;
    setBusy(id);
    setError(null);
    try {
      const secrets: Record<string, string> = {};
      for (const [k, v] of Object.entries(value.secrets)) {
        if (typeof v === 'string') secrets[k] = v;
      }
      await api.installToolset(id, { scope: { kind: 'shared' }, values: value.values, secrets });
      setConfigTarget(null);
      markInstalled(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (configTarget) {
    return (
      <div className="craftbook-toolset-setup">
        <h4 className="small">Configure {configTarget.name}</h4>
        <ToolsetConfigForm
          fields={configTarget.config ?? []}
          submitLabel="Install"
          busy={busy === configTarget.id}
          onSubmit={completeInstall}
          onCancel={() => setConfigTarget(null)}
        />
        {error && <p className="error small">{error}</p>}
      </div>
    );
  }

  return (
    <div className="craftbook-toolset-setup">
      <h4 className="small">This craftbook needs:</h4>
      <ul className="commands-panel-list">
        {missing.map((m) => {
          const done = installed.has(m.toolsetId);
          return (
            <li key={`need:${m.toolsetId}`}>
              <div className="commands-panel-item" title={m.reason ?? m.toolsetId}>
                <span className="commands-panel-item-name">{m.toolsetId}</span>
                {m.reason && (
                  <span className="commands-panel-item-desc muted small">{m.reason}</span>
                )}
                <span className="commands-panel-item-actions">
                  {done ? (
                    <span className="muted small">installed ✓</span>
                  ) : (
                    <button
                      type="button"
                      className="commands-panel-mini"
                      disabled={busy === m.toolsetId}
                      onClick={() => void beginInstall(m.toolsetId, m.sourceId, m.minVersion)}
                    >
                      {busy === m.toolsetId ? '…' : 'Install'}
                    </button>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p className="error small">{error}</p>}
      <div className="toolset-config-actions">
        <button type="button" className="gz-link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
