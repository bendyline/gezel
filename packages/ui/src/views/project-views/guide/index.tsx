import type { CodebaseMapArea, CodebaseMapResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { api } from '../../../api.js';
import type { ProjectViewProps } from '../types.js';
import '../../../styles/codebase-guide.css';

interface GuideNode {
  area: CodebaseMapArea;
  children: GuideNode[];
}

/** Each area under the nearest area whose folder contains it; the rest are roots. */
export function guideTree(areas: readonly CodebaseMapArea[]): GuideNode[] {
  const nodes = new Map<string, GuideNode>();
  for (const area of areas) nodes.set(area.path, { area, children: [] });
  const roots: GuideNode[] = [];
  for (const node of nodes.values()) {
    let parent: GuideNode | undefined;
    let dir = node.area.path;
    while (!parent && dir.includes('/')) {
      dir = dir.slice(0, dir.lastIndexOf('/'));
      parent = nodes.get(dir);
    }
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The Guide view: what each folder is for and its key files, and the files
 * the rest of the code imports most, from the index's overnight folder
 * summaries (`GET /index/codebase-map`). A file opens in the shared inspector.
 */
export default function GuideProjectView({
  projectId,
  compact,
  selectedPath,
  onSelectPath,
  setInspectorExtras,
}: ProjectViewProps) {
  const [map, setMap] = useState<CodebaseMapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<ReadonlySet<string> | null>(null);
  const whereId = useId();
  const leansId = useId();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getCodebaseMap(projectId)
      .then(setMap)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setInspectorExtras(null);
    return () => setInspectorExtras(null);
  }, [setInspectorExtras]);

  const tree = useMemo(() => (map ? guideTree(map.areas) : []), [map]);
  // The top-level folders start open, so their parts show on arrival.
  const expanded = open ?? new Set(tree.map((n) => n.area.path));
  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpen(next);
  };

  const fileRow = (path: string, purpose: string | undefined, extra?: string) => (
    <li key={path}>
      <button
        type="button"
        className="codebase-guide-file"
        title={path}
        aria-current={selectedPath === path ? 'true' : undefined}
        onClick={() => onSelectPath(path)}
      >
        <span className="codebase-guide-name">{extra ? path : baseName(path)}</span>
        {extra && <span className="codebase-guide-count">{extra}</span>}
        {purpose && <span className="codebase-guide-purpose">{purpose}</span>}
      </button>
    </li>
  );

  const folderRow = (node: GuideNode, root: boolean) => {
    const { area } = node;
    const childPaths = new Set(node.children.map((c) => c.area.path));
    // Key subfolders are listed as folders in their own right; a key file's
    // path must name a file, not repeat a folder.
    const files = area.keyFiles.filter(
      (f) => !f.path.endsWith('/') && !childPaths.has(f.path) && /\.[^/]+$/.test(f.path),
    );
    const canOpen = files.length > 0 || node.children.length > 0;
    const isOpen = canOpen && expanded.has(area.path);
    const label =
      area.path === '.' ? 'Files at the root' : `${root ? area.path : baseName(area.path)}/`;
    const body = (
      <>
        <span className="codebase-guide-chevron" aria-hidden="true">
          {canOpen && (
            <svg
              width={12}
              height={12}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <polyline points="9 6 15 12 9 18" />
            </svg>
          )}
        </span>
        <span className="codebase-guide-name">{label}</span>
        <span className="codebase-guide-purpose">{area.purpose}</span>
      </>
    );
    return (
      <li key={area.path}>
        {canOpen ? (
          <button
            type="button"
            className="codebase-guide-folder"
            title={area.path}
            aria-expanded={isOpen}
            onClick={() => toggle(area.path)}
          >
            {body}
          </button>
        ) : (
          <div className="codebase-guide-folder" title={area.path}>
            {body}
          </div>
        )}
        {isOpen && (
          <ul className="codebase-guide-list codebase-guide-list--nested">
            {files.map((f) => fileRow(f.path, f.purpose))}
            {node.children.map((child) => folderRow(child, false))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <section className={compact ? 'codebase-guide codebase-guide--compact' : 'codebase-guide'}>
      <header className="codebase-guide-header">
        <h2>What this project is</h2>
        <button type="button" className="codebase-guide-refresh" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>
      {error && <p className="codebase-guide-empty">Couldn’t load the guide: {error}</p>}
      {!error && !map && loading && <p className="codebase-guide-empty">Loading the guide…</p>}
      {!error && map && !map.indexed && (
        <p className="codebase-guide-empty">
          Gezel hasn’t mapped this folder yet. Once it has read every file, usually overnight, it
          writes what each folder is for, and this guide fills in.
        </p>
      )}
      {!error && map?.indexed && (
        <>
          {map.architecture && <p className="codebase-guide-intro">{map.architecture}</p>}
          <section aria-labelledby={whereId}>
            <h3 id={whereId}>Where things live</h3>
            <ul className="codebase-guide-list">{tree.map((node) => folderRow(node, true))}</ul>
          </section>
          {map.loadBearing.length > 0 && (
            <section aria-labelledby={leansId}>
              <h3 id={leansId}>What the rest leans on</h3>
              <p className="codebase-guide-note">The files the rest of the code imports most.</p>
              <ul className="codebase-guide-list">
                {map.loadBearing.map((f) =>
                  fileRow(f.path, f.purpose, `imported by ${f.importers}`),
                )}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}
