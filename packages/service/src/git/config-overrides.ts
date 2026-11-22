import { devNull } from 'node:os';

/**
 * What every git the service runs turns off, whoever asked for it.
 *
 * Repository config is content, not something Gezel can vouch for: a cloned
 * repository, a folder the person adds, or a write that slipped past the
 * Store's `.git` refusal can all put a `.git/config` in front of git. Four of
 * its settings run a command the config names: `core.fsmonitor` (on every
 * status and every `ls-files`, which the indexer runs on its own a minute
 * after a write), hooks, an external diff driver and a textconv driver. A
 * planted fsmonitor once ran as the daemon's account through the indexer with
 * nobody clicking anything.
 *
 * `-c` is read last, so these win over the repository's own config and any
 * file it includes. Clean/smudge filters are not covered: switching one off
 * needs its driver's name, so they rely on gezels being unable to write
 * `.git` at all.
 */
export const REPOSITORY_CONFIG_OVERRIDES: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${devNull}`,
];

/**
 * The overrides for a commit, merge or push the person started from the app.
 * Their hooks run, as they would from a terminal: Git LFS uploads objects in
 * `pre-push`, and pre-commit secret scanners and commit-msg hooks guard what
 * leaves the machine. Skipping them sent LFS pointers without objects and
 * bypassed the person's own checks without a word. fsmonitor stays off, since
 * it runs on every status and no commit needs it. Never use this for git a
 * gezel asked for or Gezel runs on its own: a gezel can write a hooks folder
 * that lives in the working tree (husky's `.husky/`).
 */
export const PERSON_STARTED_CONFIG_OVERRIDES: readonly string[] = ['-c', 'core.fsmonitor=false'];

const DIFF_FAMILY = new Set(['diff', 'log', 'show']);

/** Flags a subcommand must carry so it runs no diff or textconv program. */
export function forcedDiffFlags(subcommand: string): string[] {
  if (subcommand === 'blame') return ['--no-textconv'];
  if (DIFF_FAMILY.has(subcommand)) return ['--no-ext-diff', '--no-textconv'];
  return [];
}
