import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SHORTHAND_FLAG,
  craftbookForShorthand,
  craftbookShorthandArgv,
  shorthandEcho,
  workspaceCraftbookId,
} from './craftbook-shorthand.js';
import type { StartCraftbook } from './tui/craftbook-start.js';

const builtins = new Set(['do', 'run', 'stop', 'status', 'help', 'env', 'project']);
const argv = (...words: string[]) => ['node', 'gezel', ...words];

describe('craftbookShorthandArgv', () => {
  it('routes an unknown word to do, keeping root options before it and everything after it', () => {
    expect(
      craftbookShorthandArgv(
        argv('--home', '/tmp/h', '--standalone', 'qualla-stories', 'c23n', '--wait'),
        builtins,
      ),
    ).toEqual({
      argv: argv(
        '--home',
        '/tmp/h',
        '--standalone',
        'do',
        SHORTHAND_FLAG,
        'qualla-stories',
        'c23n',
        '--wait',
      ),
      word: 'qualla-stories',
      tail: ['c23n', '--wait'],
    });
  });

  it('leaves built-ins, aliases, and a bare gezel to commander', () => {
    expect(craftbookShorthandArgv(argv('stop', '--daemon'), builtins)).toBeNull();
    expect(craftbookShorthandArgv(argv('project', 'list'), builtins)).toBeNull();
    expect(craftbookShorthandArgv(argv('help', 'do'), builtins)).toBeNull();
    expect(craftbookShorthandArgv(argv('--standalone'), builtins)).toBeNull();
    expect(craftbookShorthandArgv(argv(), builtins)).toBeNull();
  });

  it("skips a root option's value, and --project's only when it is not a flag", () => {
    expect(craftbookShorthandArgv(argv('--connect', 'release-notes'), builtins)).toBeNull();
    expect(craftbookShorthandArgv(argv('--project', 'site', 'status'), builtins)).toBeNull();
    expect(
      craftbookShorthandArgv(argv('--project', '--standalone', 'release-notes'), builtins)?.word,
    ).toBe('release-notes');
    expect(craftbookShorthandArgv(argv('--home=/tmp/h', 'release-notes'), builtins)?.word).toBe(
      'release-notes',
    );
  });

  it('never treats a prompt or anything after -- as a craftbook name', () => {
    expect(craftbookShorthandArgv(argv('write me a poem'), builtins)).toBeNull();
    expect(craftbookShorthandArgv(argv('--', 'release-notes'), builtins)).toBeNull();
    expect(craftbookShorthandArgv(argv('./notes.md'), builtins)).toBeNull();
  });
});

describe('craftbookForShorthand', () => {
  const books = [
    { id: 'ship', name: 'Ship', command: 'ship' },
    { id: 'qualla-stories', name: 'Qualla Stories', command: 'qs' },
  ] as StartCraftbook[];

  it('matches a declared command first, then an id, ignoring case', () => {
    expect(craftbookForShorthand(books, 'QS')?.id).toBe('qualla-stories');
    expect(craftbookForShorthand(books, 'qualla-stories')?.id).toBe('qualla-stories');
  });

  it('never matches a display name or a near miss', () => {
    expect(craftbookForShorthand(books, 'Qualla Stories')).toBeUndefined();
    expect(craftbookForShorthand(books, 'shop')).toBeUndefined();
  });
});

describe('workspaceCraftbookId', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("finds a folder's own craftbook by command or id before it is a project", async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-shorthand-'));
    const book = join(dir, '.gezel', 'craftbooks', 'qualla-stories');
    await mkdir(book, { recursive: true });
    await writeFile(
      join(book, 'manifest.json'),
      JSON.stringify({ id: 'qualla-stories', command: 'qs' }),
    );
    await expect(workspaceCraftbookId(dir, 'qs')).resolves.toBe('qualla-stories');
    await expect(workspaceCraftbookId(dir, 'Qualla-Stories')).resolves.toBe('qualla-stories');
    await expect(workspaceCraftbookId(dir, 'stories')).resolves.toBeUndefined();
  });

  it('answers nothing for a folder without craftbooks', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-shorthand-'));
    await expect(workspaceCraftbookId(dir, 'qs')).resolves.toBeUndefined();
  });
});

describe('shorthandEcho', () => {
  it('prints the expanded command with shell quoting where a word needs it', () => {
    expect(shorthandEcho('summarize-long', ["Bob's notes.txt", '--wait'])).toBe(
      "→ gezel do summarize-long 'Bob'\\''s notes.txt' --wait",
    );
  });
});
