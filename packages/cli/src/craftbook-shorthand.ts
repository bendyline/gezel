/**
 * `gezel <craftbook> …` as shorthand for `gezel do <craftbook> …`, the way
 * the in-app terminal already runs a craftbook by its `command` token.
 *
 * Built-in commands always win, and only an exact `command` or id starts
 * work: a mistyped command must reach the unknown-command message, never a
 * task. Fuzzy matching would be dangerous here because bundled craftbooks
 * sit within two edits of built-ins (`ship`/`stop`, `qa`/`do`).
 *
 * The rewrite happens on argv before commander parses it. `do`'s options
 * (`--wait`, `--json`, `--param`) are not root options, so commander would
 * reject them before the root action ever saw the word.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { projectLocalCraftbooksRoot } from '@bendyline/gezel/paths';
import type { StartCraftbook } from './tui/craftbook-start.js';

/** Marks a `do` invocation that came from the shorthand. Hidden from help. */
export const SHORTHAND_FLAG = '--via-craftbook-shorthand';

/** Root options that take the next argument as their value. */
const VALUE_OPTIONS = new Set(['--connect', '--token', '--home']);
/** Root options whose value is optional: commander takes the next argument unless it is a flag. */
const OPTIONAL_VALUE_OPTIONS = new Set(['--project']);
/** What a craftbook `command` or id can look like. Anything else is never looked up. */
const CRAFTBOOK_WORD = /^[a-z0-9][a-z0-9._-]*$/i;

export interface CraftbookShorthand {
  /** argv with `do` and the shorthand marker inserted before the word. */
  argv: string[];
  /** The word the person typed where a command belongs. */
  word: string;
  /** Everything typed after the word, for echoing the expanded command. */
  tail: string[];
}

/**
 * Route `gezel [root options] <word> …` to `do` when `<word>` is not a
 * built-in. Null for a bare `gezel` (the terminal app), a built-in, or a
 * word no craftbook could be named (a quoted prompt), which keep commander's
 * own handling.
 */
export function craftbookShorthandArgv(
  argv: readonly string[],
  builtins: ReadonlySet<string>,
): CraftbookShorthand | null {
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') return null;
    if (token.startsWith('-')) {
      if (VALUE_OPTIONS.has(token)) index += 1;
      else if (OPTIONAL_VALUE_OPTIONS.has(token) && !(argv[index + 1] ?? '-').startsWith('-')) {
        index += 1;
      }
      continue;
    }
    if (builtins.has(token) || !CRAFTBOOK_WORD.test(token)) return null;
    return {
      argv: [...argv.slice(0, index), 'do', SHORTHAND_FLAG, ...argv.slice(index)],
      word: token,
      tail: argv.slice(index + 1),
    };
  }
  return null;
}

/** The craftbook a shorthand word names: its declared `command`, else its id. Never a display name. */
export function craftbookForShorthand(
  books: ReadonlyArray<StartCraftbook>,
  word: string,
): StartCraftbook | undefined {
  const query = word.toLowerCase();
  return (
    books.find((book) => book.command?.toLowerCase() === query) ??
    books.find((book) => book.id.toLowerCase() === query)
  );
}

/**
 * The id of a craftbook a folder's own `.gezel/craftbooks/` declares under
 * `word`, for a folder that is not a project yet. `gezel do` would create
 * the project and find it, so the shorthand must too, without creating
 * anything when nothing matches.
 */
export async function workspaceCraftbookId(
  workspaceDir: string,
  word: string,
): Promise<string | undefined> {
  const root = projectLocalCraftbooksRoot(workspaceDir);
  if (!existsSync(root)) return undefined;
  const query = word.toLowerCase();
  const ids: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = await readFile(join(root, entry.name, 'manifest.json'), 'utf8')
      .then((text) => JSON.parse(text) as { id?: unknown; command?: unknown })
      .catch(() => null);
    if (!manifest) continue;
    const id = typeof manifest.id === 'string' ? manifest.id : entry.name;
    if (typeof manifest.command === 'string' && manifest.command.toLowerCase() === query) return id;
    ids.push(id);
  }
  return ids.find((id) => id.toLowerCase() === query);
}

function shellWord(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;
}

/** The line printed before a shorthand runs, so logs show the real invocation. */
export function shorthandEcho(id: string, tail: readonly string[]): string {
  return `→ gezel do ${[id, ...tail].map(shellWord).join(' ')}`;
}
