import {
  type ComposedCodeContext,
  type FileContextResponse,
  composeFileContext,
} from '@bendyline/gezel';
import * as vscode from 'vscode';
import {
  OPEN_FILE_COMMAND,
  REVEAL_LINE_COMMAND,
  SHOW_SYMBOL_COMMAND,
  TOGGLE_COMMAND,
  relPathIn,
  symbolAt,
  toCommandMarkdown,
} from './code-intel-core.js';
import type { Connection } from './daemon.js';
import type { createLogger } from './log.js';

/**
 * Per-symbol code intelligence in REAL editors: a CodeLens above each symbol
 * showing the compact context strip (imported-by / uses / findings / LLM
 * one-liner), and a hover with the full markdown section. Same data + same
 * composer as the desktop app's Map file viewer — the service endpoint
 * returns facts, `composeFileContext` renders them, and the gezel link
 * grammar is rewritten to vscode `command:` URIs (code-intel-core.ts).
 *
 * v1 scope: documents inside the ACTIVE workspace folder only (mirrors the
 * extension's single-active-project model). Facts describe the on-disk file —
 * while a document is dirty its lens/hover lines drift with edits; the cache
 * invalidates on save.
 */

export interface CodeIntelDeps {
  getConnection: () => Connection | null;
  getActiveFolder: () => vscode.WorkspaceFolder | null;
  getActiveProjectId: () => string | null;
  logger: ReturnType<typeof createLogger>;
}

/** Languages the gezel indexer has tree-sitter grammars for. */
const LANGUAGE_IDS = [
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'python',
  'ruby',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'php',
  'shellscript',
  'lua',
  'swift',
  'kotlin',
  'scala',
] as const;

const NEGATIVE_TTL_MS = 60_000;
const CACHE_CAP = 50;

interface CacheEntry {
  state: 'pending' | 'ready' | 'absent';
  composed?: ComposedCodeContext;
  response?: FileContextResponse;
  at: number;
}

function toHoverMarkdown(markdown: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(toCommandMarkdown(markdown));
  md.isTrusted = { enabledCommands: [OPEN_FILE_COMMAND, REVEAL_LINE_COMMAND] };
  return md;
}

export function registerCodeIntel(deps: CodeIntelDeps): vscode.Disposable {
  const cache = new Map<string, CacheEntry>();
  let cacheConnection: Connection | null = null;
  const lensEmitter = new vscode.EventEmitter<void>();
  let providerDisposables: vscode.Disposable[] = [];

  const enabled = (): boolean =>
    vscode.workspace.getConfiguration('gezel').get<boolean>('codeIntel.enabled', true);

  const docKey = (doc: vscode.TextDocument): { projectId: string; relPath: string } | null => {
    const folder = deps.getActiveFolder();
    const projectId = deps.getActiveProjectId();
    if (!folder || !projectId) return null;
    const docFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!docFolder || docFolder.uri.toString() !== folder.uri.toString()) return null;
    const relPath = relPathIn(folder.uri.fsPath, doc.uri.fsPath);
    return relPath ? { projectId, relPath } : null;
  };

  /** Cached entry for a doc; kicks off one fetch on first sight. */
  const ensureEntry = (doc: vscode.TextDocument): CacheEntry | null => {
    const conn = deps.getConnection();
    if (!conn) return null;
    // Reconnects rotate the Connection object — old facts may be stale.
    if (conn !== cacheConnection) {
      cache.clear();
      cacheConnection = conn;
    }
    const key = docKey(doc);
    if (!key) return null;
    const id = `${key.projectId}:${key.relPath}`;
    const existing = cache.get(id);
    if (existing) {
      if (existing.state === 'absent' && Date.now() - existing.at > NEGATIVE_TTL_MS) {
        cache.delete(id);
      } else {
        return existing;
      }
    }
    const entry: CacheEntry = { state: 'pending', at: Date.now() };
    if (cache.size >= CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(id, entry);
    conn.client
      .toolFileContext(key.projectId, { path: key.relPath })
      .then((response) => {
        const composed = composeFileContext(response);
        if (composed.sections.length === 0 && !composed.fileTop) {
          Object.assign(entry, { state: 'absent', at: Date.now() });
        } else {
          Object.assign(entry, { state: 'ready', composed, response, at: Date.now() });
        }
        lensEmitter.fire();
      })
      .catch((err: unknown) => {
        Object.assign(entry, { state: 'absent', at: Date.now() });
        deps.logger.info(
          `code-intel: no context for ${key.relPath} (${err instanceof Error ? err.message : String(err)})`,
        );
      });
    return entry;
  };

  const codeLensProvider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensEmitter.event,
    provideCodeLenses(doc) {
      const entry = ensureEntry(doc);
      if (!entry || entry.state !== 'ready' || !entry.composed) return [];
      const lenses: vscode.CodeLens[] = [];
      const fileTop = entry.composed.fileTop;
      if (fileTop) {
        lenses.push(
          new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
            title: fileTop.summaryText,
            command: SHOW_SYMBOL_COMMAND,
            arguments: [doc.uri, 1],
          }),
        );
      }
      for (const s of entry.composed.sections) {
        const line = Math.max(s.line - 1, 0);
        lenses.push(
          new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
            title: s.summaryText,
            command: SHOW_SYMBOL_COMMAND,
            arguments: [doc.uri, s.line],
          }),
        );
      }
      return lenses;
    },
  };

  const hoverProvider: vscode.HoverProvider = {
    provideHover(doc, position) {
      const entry = ensureEntry(doc);
      if (!entry || entry.state !== 'ready' || !entry.composed || !entry.response) {
        return undefined;
      }
      const line = position.line + 1;
      const symbol = symbolAt(entry.response, line);
      if (symbol) {
        const section = entry.composed.sections.find(
          (s) => s.id === `${symbol.name}@${symbol.lineStart}`,
        );
        if (section?.markdown) {
          return new vscode.Hover(
            toHoverMarkdown(`${section.summaryMarkdown}\n\n${section.markdown}`),
          );
        }
      }
      if (line === 1 && entry.composed.fileTop?.markdown) {
        return new vscode.Hover(toHoverMarkdown(entry.composed.fileTop.markdown));
      }
      return undefined;
    },
  };

  const registerProviders = (): void => {
    const selector = LANGUAGE_IDS.map((language) => ({ scheme: 'file' as const, language }));
    providerDisposables = [
      vscode.languages.registerCodeLensProvider(selector, codeLensProvider),
      vscode.languages.registerHoverProvider(selector, hoverProvider),
    ];
  };
  const disposeProviders = (): void => {
    for (const d of providerDisposables) d.dispose();
    providerDisposables = [];
    cache.clear();
  };

  if (enabled()) registerProviders();

  const commandDisposables = [
    vscode.commands.registerCommand(
      OPEN_FILE_COMMAND,
      async (args: { path: string; line?: number }) => {
        const folder = deps.getActiveFolder();
        if (!folder || !args?.path) return;
        const uri = vscode.Uri.joinPath(folder.uri, ...args.path.split('/'));
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        if (args.line) {
          const pos = new vscode.Position(Math.max(args.line - 1, 0), 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      },
    ),
    vscode.commands.registerCommand(REVEAL_LINE_COMMAND, (args: { line: number }) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !args?.line) return;
      const pos = new vscode.Position(Math.max(args.line - 1, 0), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }),
    vscode.commands.registerCommand(SHOW_SYMBOL_COMMAND, async (uri: vscode.Uri, line: number) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(Math.max(line - 1, 0), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      await vscode.commands.executeCommand('editor.action.showHover');
    }),
    vscode.commands.registerCommand(TOGGLE_COMMAND, async () => {
      const next = !enabled();
      await vscode.workspace
        .getConfiguration('gezel')
        .update('codeIntel.enabled', next, vscode.ConfigurationTarget.Workspace);
      void vscode.window.setStatusBarMessage(
        `Gezel code context ${next ? 'enabled' : 'disabled'}`,
        3000,
      );
    }),
  ];

  const listenerDisposables = [
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('gezel.codeIntel.enabled')) return;
      disposeProviders();
      if (enabled()) {
        registerProviders();
        lensEmitter.fire();
      }
    }),
    // Saves may change the facts; drop the entry so the next lens/hover refetches.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const key = docKey(doc);
      if (key) cache.delete(`${key.projectId}:${key.relPath}`);
      lensEmitter.fire();
    }),
  ];

  return {
    dispose() {
      disposeProviders();
      for (const d of [...commandDisposables, ...listenerDisposables]) d.dispose();
      lensEmitter.dispose();
    },
  };
}
