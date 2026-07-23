import { api } from '../../api.js';
import { monaco } from '../monaco-base.js';
import { getTerminalCompletionData } from './completion-data.js';
import {
  type TerminalCompletionContext,
  type TerminalCompletionItem,
  type TerminalCompletionKind,
  computeTerminalCompletions,
  parseTerminalContext,
} from './completion-model.js';

/**
 * Monaco wiring for the terminal composer. HEAVY (re-exports the shared
 * `monaco-base` which pulls in monaco's editor + language services) — only
 * ever loaded via `import('./terminal-monaco-setup.js')` from a mount-time
 * effect, never the static graph, so the app bundle and jsdom tests stay
 * monaco-free.
 *
 * The terminal uses a trivial custom language id `gezel-terminal` purely as an
 * isolation boundary: the completion provider below is scoped to this language,
 * so it can never leak into the script editor's TypeScript models or any other
 * monaco surface. The provider is registered ONCE (app-global) and reads the
 * current project's sources from `completion-data` keyed by the model's
 * projectId — so it's never re-registered per project.
 */

export { monaco };

/** Project id → model URI. Encoded so the completion provider can recover it. */
export function terminalModelUri(projectId: string): monaco.Uri {
  return monaco.Uri.from({
    scheme: 'inmemory',
    authority: 'gezel-terminal',
    path: `/${encodeURIComponent(projectId)}`,
  });
}

function projectIdFromUri(uri: monaco.Uri): string {
  return decodeURIComponent(uri.path.replace(/^\//, ''));
}

let registered = false;

/** Register the `gezel-terminal` language, themes, and completion provider. Idempotent. */
export function ensureTerminalMonaco(): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: 'gezel-terminal' });
  monaco.languages.setMonarchTokensProvider('gezel-terminal', {
    tokenizer: {
      root: [
        [/^\s*[\w.\-/@]+/, 'keyword'],
        [/--?[\w-]+/, 'attribute.name'],
        [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, 'string'],
        [/.+/, ''],
      ],
    },
  });

  monaco.editor.defineTheme('gezel-terminal-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '436a2e' },
      { token: 'attribute.name', foreground: '8a6d3b' },
    ],
    colors: {
      'editor.background': '#f6f1e7',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#b0724c',
    },
  });
  monaco.editor.defineTheme('gezel-terminal-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '8fce6a' },
      { token: 'attribute.name', foreground: 'd6b07a' },
    ],
    colors: {
      'editor.background': '#111111',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
    },
  });

  monaco.languages.registerCompletionItemProvider('gezel-terminal', {
    // Space → after a token (subcommand/flag/param); `=` → value of key=…;
    // `-` → flags; `/` and `.` → descend / start a path (`src/`, `./`, `.env`).
    triggerCharacters: [' ', '=', '-', '/', '.'],
    async provideCompletionItems(model, position) {
      const lineBeforeCursor = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const ctx = parseTerminalContext(lineBeforeCursor);
      const projectId = projectIdFromUri(model.uri);
      const data = getTerminalCompletionData(projectId);
      const items = computeTerminalCompletions(ctx, data);

      // Replace the current token; when completing the value of `key=…` only the
      // part after `=` is replaced (so the key is preserved).
      const token = /\S*$/.exec(lineBeforeCursor)?.[0] ?? '';
      const tokenStart = position.column - token.length;
      const valueStart = ctx.pendingKey ? tokenStart + token.indexOf('=') + 1 : tokenStart;
      const range = new monaco.Range(
        position.lineNumber,
        valueStart,
        position.lineNumber,
        position.column,
      );
      const suggestions = items.map((it) => toMonacoItem(it, range));

      // File-path completion in argument positions (async, cached). The path
      // prefix is whatever's after the last `/` boundary — but we replace the
      // whole token so accepting `src/components/` overwrites `src/comp`.
      if (shouldCompletePaths(ctx)) {
        const paths = await fetchPaths(projectId, ctx.currentToken);
        for (const p of paths) suggestions.push(pathItem(p, range));
      }

      return { suggestions };
    },
  });
}

/** Offer file paths in an argument slot the user has started typing (not a flag/key). */
function shouldCompletePaths(ctx: TerminalCompletionContext): boolean {
  return (
    ctx.tokens.length >= 1 &&
    !ctx.pendingKey &&
    !ctx.currentToken.startsWith('-') &&
    ctx.currentToken.length >= 1
  );
}

// Small LRU over (projectId|prefix) → paths so repeated keystrokes don't re-hit.
const pathCache = new Map<string, string[]>();
const pathCacheOrder: string[] = [];

async function fetchPaths(projectId: string, prefix: string): Promise<string[]> {
  const key = `${projectId}|${prefix}`;
  const cached = pathCache.get(key);
  if (cached) return cached;
  try {
    const res = await api.searchProjectFiles(projectId, prefix);
    pathCache.set(key, res.paths);
    pathCacheOrder.push(key);
    if (pathCacheOrder.length > 100) {
      const evict = pathCacheOrder.shift();
      if (evict) pathCache.delete(evict);
    }
    return res.paths;
  } catch {
    return [];
  }
}

function pathItem(path: string, range: monaco.Range): monaco.languages.CompletionItem {
  const isDir = path.endsWith('/');
  return {
    label: path,
    kind: isDir
      ? monaco.languages.CompletionItemKind.Folder
      : monaco.languages.CompletionItemKind.File,
    insertText: path,
    filterText: path,
    sortText: `3${path}`,
    range,
    // After accepting a directory, re-open the widget so the user can descend.
    ...(isDir ? { command: { id: 'editor.action.triggerSuggest', title: '' } } : {}),
  };
}

function kindToMonaco(kind: TerminalCompletionKind): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'command':
      return K.Function;
    case 'craftbook':
      return K.Class;
    case 'mcp-tool':
      return K.Interface;
    case 'subcommand':
      return K.Method;
    case 'flag':
      return K.Property;
    case 'arg':
      return K.Variable;
    case 'enum':
      return K.EnumMember;
  }
}

function toMonacoItem(
  it: TerminalCompletionItem,
  range: monaco.Range,
): monaco.languages.CompletionItem {
  return {
    label: it.badge ? { label: it.label, description: it.badge } : it.label,
    kind: kindToMonaco(it.kind),
    insertText: it.insertText,
    filterText: it.label,
    detail: it.detail,
    documentation: it.documentation ? { value: it.documentation } : undefined,
    sortText: it.sortText,
    range,
  };
}
