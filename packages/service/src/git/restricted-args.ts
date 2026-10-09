import { devNull } from 'node:os';
import type { RunGitRequest } from '@bendyline/gezel';

/**
 * Argument policy for the model-facing `run_git` tool (`POST
 * /api/projects/:id/tools/git`).
 *
 * The tool used to pass every argument through except `-c*`, `--exec` and
 * `--upload-pack`. A denylist cannot keep up with git: `log/show/diff
 * --output=<file>` writes any file, `diff --no-index` and `blame --contents`
 * read any file, `--ext-diff` / `--textconv` run configured programs, and git
 * accepts any unambiguous abbreviation of a long option (`--out=` is
 * `--output=`). So each subcommand now has an allowlist of the options an
 * inspection needs — plus `branch`'s local create/rename/delete — and anything
 * else is refused before git runs.
 *
 * Two git behaviours need more than an option allowlist:
 *
 *   - `git diff <a> <b>` silently becomes `--no-index` when run outside a
 *     work tree or when a path points outside it, so a positional argument
 *     may never be absolute or contain a `..` segment. Revision ranges
 *     (`main..feature`) never have a `..` path segment, so they pass.
 *   - Repository config is workspace content a gezel may be able to write.
 *     {@link restrictedGitArgv} therefore disables fsmonitor and hooks for
 *     every run, and external diff drivers and textconv filters for the diff
 *     family. Clean/smudge filters declared in that config still apply.
 *
 * Usage: build the argv with {@link restrictedGitArgv} and spawn `git` with
 * it and {@link restrictedGitEnv}; never splice model arguments into a git
 * command any other way.
 *
 * Related: `http/routes/tools.ts` (the route), `RunGitRequestSchema` in
 * `@bendyline/gezel` (the subcommand set), `run_git` in `@bendyline/gezel-mcp`.
 */

export type RestrictedGitSubcommand = RunGitRequest['subcommand'];

interface OptionSpec {
  /** Exact boolean tokens, long or short. */
  flags?: readonly string[];
  /** Long options that take a value as `--opt=value` or `--opt value`. */
  valued?: readonly string[];
  /** Long options with an optional value: only ever `--opt` or `--opt=value`. */
  optionalValue?: readonly string[];
  /** Short options taking a value attached (`-n5`) or as the next argument (`-n 5`). */
  shortValued?: readonly string[];
  /** Short options whose value, when present, must be attached (`-M50%`, `-uno`). */
  shortAttached?: readonly string[];
  /** Accept `-<number>` as a commit-count limit (`git log -5`). */
  numericCount?: boolean;
}

const DIFF_OUTPUT: OptionSpec = {
  flags: [
    '-p',
    '-u',
    '--patch',
    '-s',
    '--no-patch',
    '--raw',
    '--patch-with-raw',
    '--patch-with-stat',
    '--numstat',
    '--shortstat',
    '--summary',
    '--name-only',
    '--name-status',
    '--compact-summary',
    '--full-index',
    '--binary',
    '--no-color',
    '--no-renames',
    '--check',
    '-R',
    '--no-prefix',
    '--minimal',
    '--patience',
    '--histogram',
    '-w',
    '--ignore-all-space',
    '-b',
    '--ignore-space-change',
    '--ignore-space-at-eol',
    '--ignore-blank-lines',
    '--ignore-cr-at-eol',
    '-W',
    '--function-context',
    '--text',
    '-a',
    '-z',
    '--no-ext-diff',
    '--no-textconv',
    '--exit-code',
    '--quiet',
    '--pickaxe-all',
    '--pickaxe-regex',
    '--irreversible-delete',
    '-D',
    '--find-copies-harder',
    '--no-relative',
    '--no-abbrev',
  ],
  valued: [
    '--unified',
    '--diff-filter',
    '--word-diff-regex',
    '--diff-algorithm',
    '--stat-width',
    '--stat-name-width',
    '--stat-count',
    '--src-prefix',
    '--dst-prefix',
    '--anchored',
    '--inter-hunk-context',
    '--color-moved-ws',
    '--ignore-matching-lines',
    '--rotate-to',
    '--skip-to',
  ],
  optionalValue: [
    '--stat',
    '--dirstat',
    '--color',
    '--word-diff',
    '--color-words',
    '--color-moved',
    '--find-renames',
    '--find-copies',
    '--break-rewrites',
    '--relative',
    '--abbrev',
    '--submodule',
    '--ignore-submodules',
  ],
  shortValued: ['-U', '-S', '-G', '-l', '-I'],
  shortAttached: ['-M', '-C', '-B'],
};

const COMMIT_LISTING: OptionSpec = {
  flags: [
    '--oneline',
    '--graph',
    '--all',
    '--first-parent',
    '--merges',
    '--no-merges',
    '--reverse',
    '--relative-date',
    '--follow',
    '--abbrev-commit',
    '--no-abbrev-commit',
    '--no-decorate',
    '--source',
    '--use-mailmap',
    '--mailmap',
    '--full-history',
    '--simplify-merges',
    '--ancestry-path',
    '--left-right',
    '--cherry-pick',
    '--cherry-mark',
    '--cherry',
    '--boundary',
    '--topo-order',
    '--date-order',
    '--author-date-order',
    '--no-walk',
    '--do-walk',
    '--log-size',
    '--regexp-ignore-case',
    '-i',
    '--all-match',
    '--invert-grep',
    '-E',
    '--extended-regexp',
    '-F',
    '--fixed-strings',
    '-P',
    '--perl-regexp',
    '--basic-regexp',
    '--parents',
    '--children',
    '--full-diff',
    '--show-pulls',
    '--no-notes',
  ],
  valued: [
    '--max-count',
    '--skip',
    '--since',
    '--after',
    '--until',
    '--before',
    '--author',
    '--committer',
    '--grep',
    '--format',
    '--date',
    '--min-parents',
    '--max-parents',
    '--encoding',
    '--exclude',
  ],
  optionalValue: ['--pretty', '--decorate', '--branches', '--tags', '--remotes', '--notes'],
  shortValued: ['-n', '-L'],
  numericCount: true,
};

const SPECS: Record<RestrictedGitSubcommand, readonly OptionSpec[]> = {
  status: [
    {
      flags: [
        '-s',
        '--short',
        '-b',
        '--branch',
        '--long',
        '-v',
        '--verbose',
        '-z',
        '--no-column',
        '--show-stash',
        '--ahead-behind',
        '--no-ahead-behind',
        '--renames',
        '--no-renames',
      ],
      optionalValue: [
        '--porcelain',
        '--untracked-files',
        '--ignored',
        '--ignore-submodules',
        '--column',
        '--find-renames',
      ],
      shortAttached: ['-u', '-M'],
    },
  ],
  log: [COMMIT_LISTING, DIFF_OUTPUT],
  show: [COMMIT_LISTING, DIFF_OUTPUT],
  diff: [DIFF_OUTPUT, { flags: ['--cached', '--staged', '--merge-base'] }],
  blame: [
    {
      flags: [
        '-l',
        '-t',
        '-s',
        '-e',
        '--show-email',
        '-n',
        '--show-number',
        '-f',
        '--show-name',
        '-p',
        '--porcelain',
        '--line-porcelain',
        '--incremental',
        '--root',
        '--show-stats',
        '--minimal',
        '-w',
        '-b',
        '--first-parent',
        '--reverse',
        '--no-textconv',
        '--color-lines',
        '--color-by-age',
        '--no-progress',
      ],
      valued: ['--date', '--ignore-rev'],
      optionalValue: ['--abbrev'],
      shortValued: ['-L'],
      shortAttached: ['-M', '-C'],
    },
  ],
  branch: [
    {
      flags: [
        '-a',
        '--all',
        '-r',
        '--remotes',
        '-l',
        '--list',
        '-v',
        '-vv',
        '--verbose',
        '-q',
        '--quiet',
        '--show-current',
        '-i',
        '--ignore-case',
        '--no-color',
        '--no-column',
        '--no-abbrev',
        '--contains',
        '--no-contains',
        '--merged',
        '--no-merged',
        '--points-at',
        '--omit-empty',
        '--no-track',
        // Local ref changes; the tool description limits them to explicit
        // user requests.
        '-d',
        '-D',
        '--delete',
        '-m',
        '-M',
        '--move',
        '-f',
        '--force',
      ],
      valued: ['--sort', '--format'],
      optionalValue: ['--color', '--column', '--abbrev'],
    },
  ],
  'rev-parse': [
    {
      flags: [
        '--git-dir',
        '--git-common-dir',
        '--absolute-git-dir',
        '--show-toplevel',
        '--show-prefix',
        '--show-cdup',
        '--is-inside-work-tree',
        '--is-inside-git-dir',
        '--is-bare-repository',
        '--is-shallow-repository',
        '--verify',
        '-q',
        '--quiet',
        '--symbolic',
        '--symbolic-full-name',
        '--all',
        '--revs-only',
        '--no-revs',
        '--flags',
        '--no-flags',
        '--not',
      ],
      valued: ['--default', '--since', '--after', '--until', '--before'],
      optionalValue: [
        '--short',
        '--abbrev-ref',
        '--branches',
        '--tags',
        '--remotes',
        '--show-object-format',
      ],
    },
  ],
  'ls-files': [
    {
      flags: [
        '-c',
        '--cached',
        '-d',
        '--deleted',
        '-m',
        '--modified',
        '-o',
        '--others',
        '-i',
        '--ignored',
        '-s',
        '--stage',
        '-u',
        '--unmerged',
        '-k',
        '--killed',
        '-z',
        '-t',
        '-v',
        '-f',
        '--directory',
        '--no-empty-directory',
        '--exclude-standard',
        '--full-name',
        '--error-unmatch',
        '--eol',
        '--deduplicate',
        '--sparse',
      ],
      valued: ['--exclude', '--format'],
      optionalValue: ['--abbrev'],
      shortValued: ['-x'],
    },
  ],
};

const DIFF_FAMILY: ReadonlySet<RestrictedGitSubcommand> = new Set(['log', 'show', 'diff']);
const ATTACHED_VALUE = /^[0-9a-z%/.]*$/i;
const MAX_ARG_LENGTH = 4096;

/**
 * The full argv for `git` — global hardening, the subcommand, forced safety
 * flags, then the caller's arguments — or why they were refused.
 */
export function restrictedGitArgv(
  subcommand: RestrictedGitSubcommand,
  args: readonly string[],
): { argv: string[] } | { error: string } {
  const specs = SPECS[subcommand];
  if (!specs) return { error: `git ${subcommand} is not allowed` };
  const checked = checkArgs(subcommand, specs, args);
  if (checked) return { error: checked };
  const forced =
    subcommand === 'blame'
      ? ['--no-textconv']
      : DIFF_FAMILY.has(subcommand)
        ? ['--no-ext-diff', '--no-textconv']
        : [];
  return {
    argv: [
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${devNull}`,
      subcommand,
      ...forced,
      ...args,
    ],
  };
}

/**
 * The parent environment without `GIT_*` variables, which can point git at
 * another repository, index or external diff program, plus no credential
 * prompts and no optional index locks for the read-only commands.
 */
export function restrictedGitEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined || key.toUpperCase().startsWith('GIT_')) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function checkArgs(
  subcommand: RestrictedGitSubcommand,
  specs: readonly OptionSpec[],
  args: readonly string[],
): string | null {
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') return 'git args must be strings';
    if (arg.length > MAX_ARG_LENGTH) return 'git arg is too long';
    if (/[\0\n\r]/.test(arg)) return 'git args cannot contain newlines or NUL bytes';

    if (positionalOnly || !arg.startsWith('-') || arg === '-') {
      const pathProblem = positionalPathProblem(arg);
      if (pathProblem) return pathProblem;
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      continue;
    }

    const consumed = matchOption(specs, arg);
    if (consumed === null) {
      return `git ${subcommand} option "${arg}" is not allowed (run_git accepts read-only inspection options only)`;
    }
    if (consumed === 'next') {
      if (i + 1 >= args.length) return `git option "${arg}" needs a value`;
      i++;
    }
  }
  return null;
}

/** `true` when matched alone, `'next'` when the following argument is its value. */
function matchOption(specs: readonly OptionSpec[], arg: string): true | 'next' | null {
  for (const spec of specs) {
    if (spec.flags?.includes(arg)) return true;
    if (spec.numericCount && /^-\d+$/.test(arg)) return true;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (spec.valued?.includes(name)) return eq === -1 ? 'next' : true;
      if (spec.optionalValue?.includes(name)) return true;
      continue;
    }
    const short = arg.slice(0, 2);
    const rest = arg.slice(2);
    if (spec.shortValued?.includes(short)) return rest === '' ? 'next' : true;
    if (spec.shortAttached?.includes(short) && ATTACHED_VALUE.test(rest)) return true;
  }
  if (/^-[a-zA-Z]{2,}$/.test(arg)) {
    const letters = [...arg.slice(1)].map((letter) => `-${letter}`);
    if (letters.every((flag) => specs.some((spec) => spec.flags?.includes(flag)))) return true;
  }
  return null;
}

function positionalPathProblem(arg: string): string | null {
  if (/^([/\\~]|[a-zA-Z]:)/.test(arg)) {
    return `git argument "${arg}" is an absolute path; use a path relative to the project workspace`;
  }
  if (arg.split(/[/\\]/).includes('..')) {
    return `git argument "${arg}" leaves the project workspace ("..")`;
  }
  return null;
}
