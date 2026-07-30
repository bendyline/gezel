import type {
  CatalogItemDetail,
  CatalogItemSummary,
  InstalledToolset,
  ToolsetConfigField,
  ToolsetManifest,
  ToolsetsScope,
} from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Dialog, Tabs } from '../primitives/index.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { ToolsetConfigForm, type ToolsetConfigFormValue } from './ToolsetConfigForm.js';

interface ToolsetsEditorProps {
  scope: ToolsetsScope;
  /** Subject displayed in the header — a gezel name, or "everyone" for shared. */
  subject: string;
  /** Optional helper sentence shown under the header. */
  hint?: string;
}

interface InstallTarget {
  manifest: ToolsetManifest;
}

interface ConfigureTarget {
  toolsetId: string;
  fields: ToolsetConfigField[];
  initialValues: Record<string, string>;
  secretsPresent: Record<string, boolean>;
  secretMasks: Record<string, string>;
  orphanedValueIds: string[];
  orphanedSecretIds: string[];
}

interface RoleDefault {
  role: string | null;
  groupIds: string[];
  groupNames: string[];
}

/**
 * Renders a toolset icon. Built-in toolsets ship inline SVG via
 * `iconSvg` (rendered with `dangerouslySetInnerHTML` since the
 * source is trusted catalog data). Third-party toolsets fall back
 * to `<img src={logoUrl}>`. Either path lands in the same square
 * frame so the tile grid stays aligned. Final fallback is a
 * lettered placeholder.
 */
function ToolsetIcon({
  iconSvg,
  logoUrl,
  name,
  className,
}: {
  iconSvg?: string;
  logoUrl?: string;
  name: string;
  className: string;
}) {
  if (iconSvg) {
    // biome-ignore lint/security/noDangerouslySetInnerHtml: toolset icon SVGs are server-sanitized before delivery
    return <span className={className} dangerouslySetInnerHTML={{ __html: iconSvg }} />;
  }
  if (logoUrl) {
    return <img className={className} src={logoUrl} alt="" />;
  }
  return <div className={`${className} toolsets-tile-icon-placeholder`}>{name.slice(0, 1)}</div>;
}

/**
 * Tile rendered inside the toolsets grid. `tone` controls visual weight:
 *   - `installed`  — full-color tile for an entry the user pinned.
 *   - `inherited`  — muted tile for a built-in group that's active via
 *                    the role default but not explicitly pinned.
 */
function ToolsetTile({
  name,
  iconSvg,
  logoUrl,
  tone,
  caption,
  onConfigure,
  onRemove,
  busy,
}: {
  name: string;
  iconSvg?: string;
  logoUrl?: string;
  tone: 'installed' | 'inherited';
  caption?: string;
  onConfigure?: () => void;
  onRemove?: () => void;
  busy?: boolean;
}) {
  return (
    <div className={`toolsets-tile toolsets-tile-${tone}`}>
      <ToolsetIcon iconSvg={iconSvg} logoUrl={logoUrl} name={name} className="toolsets-tile-icon" />
      <div className="toolsets-tile-body">
        <div className="toolsets-tile-name">{name}</div>
        {caption && <div className="toolsets-tile-caption">{caption}</div>}
      </div>
      {(onConfigure || onRemove) && (
        <div className="toolsets-tile-actions">
          {onConfigure && (
            <button
              type="button"
              className="toolsets-tile-action"
              disabled={busy}
              onClick={onConfigure}
              title="Configure"
              aria-label="Configure"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="toolsets-tile-action toolsets-tile-action-danger"
              disabled={busy}
              onClick={onRemove}
              title="Remove"
              aria-label="Remove"
            >
              {busy ? (
                <span className="toolsets-tile-action-spinner">…</span>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 6h18" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                </svg>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolsetsEditor({ scope, subject, hint }: ToolsetsEditorProps) {
  const [installed, setInstalled] = useState<InstalledToolset[]>([]);
  const [roleDefault, setRoleDefault] = useState<RoleDefault | null>(null);
  const [catalog, setCatalog] = useState<CatalogItemSummary[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTab, setPickerTab] = useState<'catalog' | 'custom'>('catalog');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [discoveryWarnings, setDiscoveryWarnings] = useState<string[]>([]);
  const [customText, setCustomText] = useState('');
  const [customSourceName, setCustomSourceName] = useState('Pasted JSON');
  const [installTarget, setInstallTarget] = useState<InstallTarget | null>(null);
  const [configureTarget, setConfigureTarget] = useState<ConfigureTarget | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [roster, items] = await Promise.all([
        api.listInstalledToolsets(scope),
        api.listCatalogItems('toolset'),
      ]);
      setInstalled(roster.toolsets ?? []);
      setRoleDefault(roster.roleDefault ?? null);
      setDiscoveryWarnings((roster.discoveryWarnings ?? []).map((warning) => warning.message));
      setCatalog(items.items);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const catalogById = useMemo(() => {
    const map = new Map<string, CatalogItemSummary>();
    for (const it of catalog) map.set(it.manifest.id, it);
    return map;
  }, [catalog]);

  const builtinInstalledGroupIds = useMemo(() => {
    return new Set(
      installed
        .filter((t) => t.runtime.kind === 'builtin')
        .map((t) => (t.runtime as { kind: 'builtin'; toolsetGroupId: string }).toolsetGroupId),
    );
  }, [installed]);

  const inheritsRoleDefault =
    scope.kind === 'gezel' && roleDefault !== null && builtinInstalledGroupIds.size === 0;

  /** Inherited group ids that aren't explicitly installed — surfaced as muted tiles. */
  const inheritedTiles = useMemo(() => {
    if (!inheritsRoleDefault || !roleDefault) return [];
    return roleDefault.groupIds
      .filter((gid) => !builtinInstalledGroupIds.has(gid))
      .map((gid) => {
        const catalogId = `builtin.${gid}`;
        const item = catalogById.get(catalogId);
        return {
          groupId: gid,
          catalogId,
          name: item?.manifest.name ?? gid,
          iconSvg: item?.iconSvg,
          logoUrl: item?.logoUrl,
        };
      });
  }, [inheritsRoleDefault, roleDefault, builtinInstalledGroupIds, catalogById]);

  const install = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const detail = (await api.getCatalogItem('toolset', id)) as CatalogItemDetail;
      if (detail.manifest.kind !== 'toolset') {
        throw new Error('catalog item is not a toolset');
      }
      const manifest = detail.manifest as ToolsetManifest;
      if ((manifest.config ?? []).length === 0) {
        await api.installToolset(id, { scope });
        await refresh();
        setShowPicker(false);
      } else {
        setInstallTarget({ manifest });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const completeInstall = async (value: ToolsetConfigFormValue) => {
    if (!installTarget) return;
    const id = installTarget.manifest.id;
    setBusy(id);
    setError(null);
    try {
      const secrets: Record<string, string> = {};
      for (const [k, v] of Object.entries(value.secrets)) {
        if (typeof v === 'string') secrets[k] = v;
      }
      await api.installToolset(id, {
        scope,
        values: value.values,
        secrets,
      });
      await refresh();
      setInstallTarget(null);
      setShowPicker(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openConfigure = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const [detail, config] = await Promise.all([
        api.getCatalogItem('toolset', id) as Promise<CatalogItemDetail>,
        api.getToolsetConfig(id),
      ]);
      if (detail.manifest.kind !== 'toolset') {
        throw new Error('catalog item is not a toolset');
      }
      const manifest = detail.manifest as ToolsetManifest;
      setConfigureTarget({
        toolsetId: id,
        fields: manifest.config ?? [],
        initialValues: config.values,
        secretsPresent: config.secretsPresent,
        secretMasks: config.secretMasks,
        orphanedValueIds: config.orphaned.values,
        orphanedSecretIds: config.orphaned.secrets,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const submitConfigure = async (value: ToolsetConfigFormValue) => {
    if (!configureTarget) return;
    const id = configureTarget.toolsetId;
    setBusy(id);
    setError(null);
    try {
      await api.updateToolsetConfig(id, {
        values: value.values,
        secrets: value.secrets,
      });
      setConfigureTarget(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (id: string) => {
    setBusy(id);
    try {
      await api.uninstallToolset(id, scope);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const importCustomConfig = async () => {
    if (!customText.trim()) return;
    setBusy('__custom_import__');
    setError(null);
    setNotices([]);
    try {
      const result = await api.importCustomMcpConfig({
        scope,
        text: customText,
        sourceName: customSourceName.trim() || 'Pasted JSON',
      });
      await refresh();
      setNotices([
        `Imported ${result.imported.length} custom MCP server${result.imported.length === 1 ? '' : 's'}: ${result.imported.join(', ')}`,
        ...result.warnings.map((warning) =>
          warning.serverName ? `${warning.serverName}: ${warning.message}` : warning.message,
        ),
      ]);
      setCustomText('');
      setCustomSourceName('Pasted JSON');
      setShowPicker(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const readCustomFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      setCustomText(text);
      setCustomSourceName(file.name);
    } catch (err) {
      setError(`Could not read ${file.name}: ${(err as Error).message}`);
    }
  };

  /**
   * Convert the inherited-via-role-default state into an explicitly
   * managed list by installing every inherited built-in group at
   * once. After this, the user owns the list and can remove
   * individual entries.
   */
  const customizeFromRoleDefault = async () => {
    if (!roleDefault || roleDefault.groupIds.length === 0) return;
    setBusy('__customize__');
    setError(null);
    try {
      for (const gid of roleDefault.groupIds) {
        await api.installToolset(`builtin.${gid}`, { scope });
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const tileNameFor = (entry: InstalledToolset): string => {
    if (entry.runtime.kind === 'custom-mcp') return entry.runtime.serverName;
    return catalogById.get(entry.toolsetId)?.manifest.name ?? entry.toolsetId;
  };
  const tileIconSvgFor = (entry: InstalledToolset): string | undefined => {
    return catalogById.get(entry.toolsetId)?.iconSvg;
  };
  const tileLogoFor = (entry: InstalledToolset): string | undefined => {
    return catalogById.get(entry.toolsetId)?.logoUrl;
  };
  const tileCaptionFor = (entry: InstalledToolset): string | undefined => {
    if (entry.runtime.kind !== 'custom-mcp') return undefined;
    if (entry.runtime.source.kind === 'project-file') {
      return `Project config · ${entry.runtime.source.relativePath}`;
    }
    return entry.runtime.source.sourceName
      ? `Custom · ${entry.runtime.source.sourceName}`
      : 'Custom MCP';
  };

  return (
    <div className="gezel-toolsets-panel">
      <div className="gezel-toolsets-header">
        <span className="muted small">
          {scope.kind === 'project' ? (
            'Additional project toolsets'
          ) : (
            <>
              <i>Toolsets</i> for {subject}
            </>
          )}
          {installed.length > 0 ? ` (${installed.length})` : ''}
        </span>
        <button type="button" onClick={() => setShowPicker(true)}>
          + Add toolset
        </button>
      </div>
      {hint && (
        <p className="muted small" style={{ marginTop: '0.25rem' }}>
          {hint}
        </p>
      )}
      {inheritsRoleDefault && roleDefault && (
        <div className="toolsets-inherit-banner">
          <p className="muted small" style={{ margin: 0 }}>
            Inheriting{' '}
            {roleDefault.role ? (
              <>
                the <strong>{roleDefault.role}</strong> role default
              </>
            ) : (
              <>the default toolset bundle</>
            )}
            . Add a built-in toolset below to override, or click <em>Customize</em> to take over the
            full list.
          </p>
          {roleDefault.groupIds.length > 0 && (
            <button
              type="button"
              className="home-link"
              disabled={busy !== null}
              onClick={() => void customizeFromRoleDefault()}
            >
              {busy === '__customize__' ? 'Customizing…' : 'Customize'}
            </button>
          )}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      {notices.map((notice) => (
        <p key={notice} className="status small toolsets-notice">
          {notice}
        </p>
      ))}
      {discoveryWarnings.map((warning) => (
        <p key={warning} className="warning small toolsets-notice">
          Project MCP config: {warning}
        </p>
      ))}
      {(installed.length > 0 || inheritedTiles.length > 0) && (
        <div className="toolsets-tile-grid">
          {installed.map((entry) => (
            <ToolsetTile
              key={entry.toolsetId}
              name={tileNameFor(entry)}
              iconSvg={tileIconSvgFor(entry)}
              logoUrl={tileLogoFor(entry)}
              tone="installed"
              caption={tileCaptionFor(entry)}
              busy={busy === entry.toolsetId}
              onConfigure={
                catalogById.has(entry.toolsetId)
                  ? () => void openConfigure(entry.toolsetId)
                  : undefined
              }
              onRemove={
                entry.runtime.kind === 'custom-mcp' && entry.runtime.source.kind === 'project-file'
                  ? undefined
                  : () => void uninstall(entry.toolsetId)
              }
            />
          ))}
          {inheritedTiles.map((tile) => (
            <ToolsetTile
              key={tile.catalogId}
              name={tile.name}
              iconSvg={tile.iconSvg}
              logoUrl={tile.logoUrl}
              tone="inherited"
              caption="Role default"
            />
          ))}
        </div>
      )}

      <Dialog.Root
        open={showPicker && !installTarget}
        onOpenChange={(next) => {
          if (!next) setShowPicker(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="template-picker-dialog toolsets-picker-dialog">
            <header
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <Dialog.Title asChild>
                <h3 style={{ margin: 0 }}>Add toolset</h3>
              </Dialog.Title>
              <button type="button" className="home-link" onClick={() => setShowPicker(false)}>
                Cancel
              </button>
            </header>
            <Tabs.Root
              value={pickerTab}
              onValueChange={(value) => setPickerTab(value as 'catalog' | 'custom')}
              className="toolsets-picker-tabs"
            >
              <Tabs.List aria-label="Toolset source">
                <Tabs.Trigger value="catalog">Catalog</Tabs.Trigger>
                <Tabs.Trigger value="custom">Custom MCP</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="catalog">
                <CatalogBrowser
                  kind="toolset"
                  emptyMessage="No toolsets in the catalog yet."
                  // Pass items only after the parent fetch has populated
                  // them, so the picker doesn't briefly flash an empty
                  // state when opened mid-fetch. catalog.length === 0 is
                  // treated as "not yet loaded" — a truly empty catalog
                  // would just trigger one redundant fetch with the same
                  // result.
                  initialItems={catalog.length > 0 ? catalog : undefined}
                  action={(item) => {
                    if (item.manifest.kind !== 'toolset') return null;
                    const m = item.manifest;
                    const already = installed.some((t) => t.toolsetId === m.id);
                    return (
                      <button
                        type="button"
                        disabled={already || busy !== null}
                        onClick={() => void install(m.id)}
                      >
                        {already ? 'Installed' : busy === m.id ? 'Loading…' : 'Install'}
                      </button>
                    );
                  }}
                />
              </Tabs.Content>
              <Tabs.Content value="custom" className="toolsets-custom-import">
                <div>
                  <h4>Import MCP configuration</h4>
                  <p className="muted small">
                    Choose a local JSON file or paste its contents. Gezel accepts VS Code’s{' '}
                    <code>servers</code> format and the common <code>mcpServers</code> format used
                    by Claude and Cursor.
                  </p>
                </div>
                <label className="toolsets-custom-file">
                  <span>Configuration file</span>
                  <input
                    type="file"
                    accept=".json,.jsonc,application/json"
                    onChange={(event) => void readCustomFile(event.currentTarget.files?.[0])}
                  />
                </label>
                <label>
                  <span>JSON</span>
                  <textarea
                    rows={14}
                    spellCheck={false}
                    value={customText}
                    onChange={(event) => {
                      setCustomText(event.target.value);
                      if (customSourceName !== 'Pasted JSON') setCustomSourceName('Pasted JSON');
                    }}
                    placeholder={`{\n  "servers": {\n    "example": {\n      "command": "npx",\n      "args": ["-y", "@example/mcp-server"]\n    }\n  }\n}`}
                  />
                </label>
                <p className="warning small">
                  MCP servers can run code or contact external services. Import only configurations
                  you trust. Environment values and HTTP headers are kept in Gezel’s secret store.
                </p>
                <div className="toolsets-custom-actions">
                  <button type="button" className="home-link" onClick={() => setShowPicker(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!customText.trim() || busy !== null}
                    onClick={() => void importCustomConfig()}
                  >
                    {busy === '__custom_import__' ? 'Importing…' : 'Import toolsets'}
                  </button>
                </div>
              </Tabs.Content>
            </Tabs.Root>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={installTarget !== null}
        onOpenChange={(next) => {
          if (!next) setInstallTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="template-picker-dialog">
            <header
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <Dialog.Title asChild>
                <h3 style={{ margin: 0 }}>Configure {installTarget?.manifest.name}</h3>
              </Dialog.Title>
            </header>
            <p className="muted small">
              Values configured here apply globally — every gezel that installs this toolset shares
              the same configuration.
            </p>
            {installTarget && (
              <ToolsetConfigForm
                fields={installTarget.manifest.config ?? []}
                submitLabel="Install"
                busy={busy !== null}
                onSubmit={completeInstall}
                onCancel={() => setInstallTarget(null)}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={configureTarget !== null}
        onOpenChange={(next) => {
          if (!next) setConfigureTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="template-picker-dialog">
            <header
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <Dialog.Title asChild>
                <h3 style={{ margin: 0 }}>Configure {configureTarget?.toolsetId}</h3>
              </Dialog.Title>
            </header>
            <p className="muted small">
              Configuration for <code>{configureTarget?.toolsetId}</code> is shared across every
              gezel that installs it.
            </p>
            {configureTarget && (
              <ToolsetConfigForm
                fields={configureTarget.fields}
                initialValues={configureTarget.initialValues}
                initialSecretsPresent={configureTarget.secretsPresent}
                initialSecretMasks={configureTarget.secretMasks}
                orphanedValueIds={configureTarget.orphanedValueIds}
                orphanedSecretIds={configureTarget.orphanedSecretIds}
                submitLabel="Save"
                busy={busy !== null}
                onSubmit={submitConfigure}
                onCancel={() => setConfigureTarget(null)}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
