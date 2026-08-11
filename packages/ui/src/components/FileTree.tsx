import { type ReactNode, useState } from 'react';
import { ContextMenu, DropdownMenu } from '../primitives/index.js';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
}

export interface FileTreeAction {
  label: string;
  onSelect: (entry: FileEntry) => void | Promise<void>;
  disabled?: boolean;
}

export interface FileTreeProps {
  entries: FileEntry[];
  selectedPath?: string;
  onSelect: (entry: FileEntry) => void;
  /** Optional per-row rename action, exposed through ⋯ and right-click menus. */
  onRename?: (entry: FileEntry) => void;
  /** Optional per-row delete action, exposed through ⋯ and right-click menus. */
  onDelete?: (entry: FileEntry) => void;
  /** Optional host-defined actions, exposed through both row menus. */
  actionsForEntry?: (entry: FileEntry) => readonly FileTreeAction[];
  /** Optional read-only row status rendered after the label. */
  trailingForEntry?: (entry: FileEntry) => ReactNode;
  /** Depth at which child nodes are initially collapsed. Default 2. */
  defaultExpandedDepth?: number;
  /** Custom icon override. Receives the entry and returns a ReactNode
   *  (e.g. a FontAwesome `<i>` element or an emoji string). */
  iconFor?: (entry: FileEntry) => ReactNode;
  /**
   * Row label override. Defaults to the raw entry name. Hosts that show a
   * single known format (the documents library) pass `documentLabel` to drop
   * the redundant extension; anything file-manager-shaped leaves it alone.
   */
  labelFor?: (entry: FileEntry) => string;
  /**
   * When true, clicking a folder's *label* selects it (`onSelect`) instead
   * of toggling its expansion; the chevron still expands/collapses. Lets a
   * host show a folder-detail surface on selection. Default false — the
   * label toggles expansion (the sidebar/navigation behavior).
   */
  selectableFolders?: boolean;
}

/** Convert a flat list of file entries (with slash-separated `path`) into a tree. */
export function buildTree(flat: FileEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();
  for (const f of flat) {
    byPath.set(f.path, {
      name: f.name,
      path: f.path,
      isDirectory: f.isDirectory,
      children: [],
    });
  }
  for (const f of flat) {
    const node = byPath.get(f.path);
    if (!node) continue;
    const parentPath = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const parent = parentPath ? byPath.get(parentPath) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function defaultIconFor(entry: FileEntry): ReactNode {
  // FontAwesome Free icons. The webfont + `.fa-*` utility classes are
  // loaded app-wide via `@bendyline/squisq-editor-react/styles` (which
  // bundles `@fortawesome/fontawesome-free`), so no extra import is needed.
  // `fa-fw` fixed-width keeps file and folder labels aligned. The icons are
  // purely decorative — the glyph is injected via a CSS `::before` pseudo-element,
  // so `aria-hidden` keeps screen readers from announcing it as a stray glyph.
  // A plain `<i>` isn't focusable, so the rule is a false positive here.
  if (entry.isDirectory) {
    return (
      // biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative icon, not focusable
      <i className="tree-icon tree-icon-folder fa-regular fa-folder fa-fw" aria-hidden="true" />
    );
  }
  if (/\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(entry.name)) {
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative icon, not focusable
    return <i className="tree-icon fa-regular fa-file-image fa-fw" aria-hidden="true" />;
  }
  // biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative icon, not focusable
  return <i className="tree-icon fa-regular fa-file-lines fa-fw" aria-hidden="true" />;
}

function defaultLabelFor(entry: FileEntry): string {
  return entry.name;
}

export function FileTree({
  entries,
  selectedPath,
  onSelect,
  onRename,
  onDelete,
  actionsForEntry,
  trailingForEntry,
  defaultExpandedDepth = 2,
  iconFor = defaultIconFor,
  labelFor = defaultLabelFor,
  selectableFolders = false,
}: FileTreeProps) {
  const tree = buildTree(entries);
  return (
    <>
      {tree.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
          actionsForEntry={actionsForEntry}
          trailingForEntry={trailingForEntry}
          defaultExpandedDepth={defaultExpandedDepth}
          iconFor={iconFor}
          labelFor={labelFor}
          selectableFolders={selectableFolders}
        />
      ))}
    </>
  );
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  selectedPath?: string;
  onSelect: (entry: FileEntry) => void;
  onRename?: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
  actionsForEntry?: (entry: FileEntry) => readonly FileTreeAction[];
  trailingForEntry?: (entry: FileEntry) => ReactNode;
  defaultExpandedDepth: number;
  iconFor: (entry: FileEntry) => ReactNode;
  labelFor: (entry: FileEntry) => string;
  selectableFolders: boolean;
}

function TreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  onRename,
  onDelete,
  actionsForEntry,
  trailingForEntry,
  defaultExpandedDepth,
  iconFor,
  labelFor,
  selectableFolders,
}: TreeItemProps) {
  const [expanded, setExpanded] = useState(depth < defaultExpandedDepth);
  const entry: FileEntry = {
    name: node.name,
    path: node.path,
    isDirectory: node.isDirectory,
  };
  const label = labelFor(entry);
  const customActions = actionsForEntry?.(entry) ?? [];
  const trailing = trailingForEntry?.(entry);
  const hasActions = Boolean(onRename || onDelete || customActions.length > 0);
  const canExpand = node.isDirectory && node.children.length > 0;

  const row = (
    <div
      className={`tree-row${selectedPath === node.path ? ' tree-row-selected' : ''}`}
      style={{ paddingLeft: `${depth * 16 + 4}px` }}
    >
      {canExpand ? (
        <button
          type="button"
          className="tree-toggle"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
        >
          {/* Rotating chevron matching the sidebar group caret, so folder
              toggles read consistently with the section headers (\u25B8 \u2192 \u2304)
              rather than a filled triangle. */}
          <span className={`tree-toggle-caret${expanded ? ' expanded' : ''}`} aria-hidden="true">
            <svg
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              focusable="false"
              aria-hidden="true"
            >
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </span>
        </button>
      ) : (
        <span className="tree-toggle-spacer" />
      )}
      <button
        type="button"
        className="tree-label"
        onClick={() => {
          // Files always select. Folders select only when the host opts
          // in via `selectableFolders`; otherwise the label toggles
          // expansion (the chevron handles expansion in both modes).
          if (!node.isDirectory || selectableFolders) onSelect(entry);
          else setExpanded(!expanded);
        }}
      >
        {iconFor(entry)} {label}
      </button>
      {trailing && <span className="tree-row-trailing">{trailing}</span>}
      {hasActions && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="tree-actions-trigger"
              aria-label={`Actions for ${label}`}
              title={`Actions for ${label}`}
            >
              <span aria-hidden="true">⋯</span>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="app-nav-menu tree-actions-menu"
              sideOffset={4}
              align="end"
            >
              {onRename && (
                <DropdownMenu.Item className="app-nav-menu-item" onSelect={() => onRename(entry)}>
                  Rename…
                </DropdownMenu.Item>
              )}
              {onDelete && (
                <DropdownMenu.Item
                  className="app-nav-menu-item danger"
                  onSelect={() => onDelete(entry)}
                >
                  Delete…
                </DropdownMenu.Item>
              )}
              {customActions.length > 0 && (onRename || onDelete) && (
                <DropdownMenu.Separator className="app-nav-menu-separator" />
              )}
              {customActions.map((action) => (
                <DropdownMenu.Item
                  key={action.label}
                  className="app-nav-menu-item"
                  disabled={action.disabled}
                  onSelect={() => void action.onSelect(entry)}
                >
                  {action.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );

  return (
    <div>
      {hasActions ? (
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content className="app-nav-menu tree-actions-menu">
              {onRename && (
                <ContextMenu.Item className="app-nav-menu-item" onSelect={() => onRename(entry)}>
                  Rename…
                </ContextMenu.Item>
              )}
              {onDelete && (
                <ContextMenu.Item
                  className="app-nav-menu-item danger"
                  onSelect={() => onDelete(entry)}
                >
                  Delete…
                </ContextMenu.Item>
              )}
              {customActions.length > 0 && (onRename || onDelete) && (
                <ContextMenu.Separator className="app-nav-menu-separator" />
              )}
              {customActions.map((action) => (
                <ContextMenu.Item
                  key={action.label}
                  className="app-nav-menu-item"
                  disabled={action.disabled}
                  onSelect={() => void action.onSelect(entry)}
                >
                  {action.label}
                </ContextMenu.Item>
              ))}
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      ) : (
        row
      )}
      {canExpand && expanded && (
        <div>
          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
              actionsForEntry={actionsForEntry}
              trailingForEntry={trailingForEntry}
              defaultExpandedDepth={defaultExpandedDepth}
              iconFor={iconFor}
              labelFor={labelFor}
              selectableFolders={selectableFolders}
            />
          ))}
        </div>
      )}
    </div>
  );
}
