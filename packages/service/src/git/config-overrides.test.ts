import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forcedDiffFlags } from './config-overrides.js';
import { runGit, subcommandIndex } from './git.js';

describe('subcommandIndex', () => {
  it.each([
    [['status'], 0],
    [['-c', 'user.name=a', '-c', 'user.email=b', 'commit', '-m', 'msg'], 4],
    [['-C', '/repo', 'diff', 'HEAD'], 2],
    [['--no-pager', 'log'], 1],
    [['--version'], -1],
  ])('finds the subcommand in %j', (args, index) => {
    expect(subcommandIndex(args)).toBe(index);
  });
});

describe('forcedDiffFlags', () => {
  it('turns off external diff and textconv for the diff family, textconv for blame', () => {
    for (const subcommand of ['diff', 'log', 'show']) {
      expect(forcedDiffFlags(subcommand)).toEqual(['--no-ext-diff', '--no-textconv']);
    }
    expect(forcedDiffFlags('blame')).toEqual(['--no-textconv']);
    expect(forcedDiffFlags('status')).toEqual([]);
  });
});

const gitAvailable = spawnSync('git', ['--version']).status === 0;

/**
 * A repository whose `.git/config` names programs, the way a gezel-written
 * config once did: the indexer's `git ls-files` ran its fsmonitor as the
 * daemon's account with nobody clicking anything. Every git the service runs
 * goes through `runGit`, so none of these may run there.
 */
describe.runIf(gitAvailable)('runGit against a repository whose config runs programs', () => {
  let root: string;
  let repo: string;
  let env: Record<string, string>;
  const markers = ['fsmonitor', 'extdiff', 'textconv', 'hook'];
  // Git runs these through its shell from the work tree root, so a relative
  // path reaches the marker everywhere, Git for Windows' sh included.
  const touch = (name: string) => `touch ../PWNED-${name}`;
  const ran = (name: string) => existsSync(join(root, `PWNED-${name}`));

  function plainGit(args: string[]) {
    return spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000, env });
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-rungit-config-'));
    repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    // The developer's own config (a global hooksPath, say) must not decide this.
    await writeFile(join(root, 'empty.gitconfig'), '');
    env = {
      ...(process.env as Record<string, string>),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'),
    };
    plainGit(['init', '-q']);
    plainGit(['config', 'user.email', 'probe@example.invalid']);
    plainGit(['config', 'user.name', 'probe']);
    await writeFile(join(repo, 'a.txt'), 'hi\n');
    plainGit(['add', 'a.txt']);
    plainGit(['commit', '-qm', 'init']);

    await appendFile(
      join(repo, '.git', 'config'),
      [
        '[core]',
        `\tfsmonitor = "${touch('fsmonitor')}; false"`,
        '[diff]',
        `\texternal = "${touch('extdiff')}; true"`,
        '[diff "probe"]',
        `\ttextconv = "${touch('textconv')}; cat"`,
        '',
      ].join('\n'),
    );
    await writeFile(join(repo, '.gitattributes'), '*.txt diff=probe\n');
    for (const hook of ['pre-commit', 'reference-transaction']) {
      const path = join(repo, '.git', 'hooks', hook);
      await writeFile(path, `#!/bin/sh\n${touch('hook')}\n`);
      await chmod(path, 0o755);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs none of them, including for the indexer and a commit', async () => {
    await appendFile(join(repo, 'a.txt'), 'bye\n');
    const opts = { cwd: repo, env };
    await runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], opts);
    await runGit(['status', '--porcelain=v1', '-z'], opts);
    await runGit(['diff', 'HEAD', '-M'], opts);
    await runGit(['log', '-p', '-1'], opts);
    await runGit(['show', 'HEAD'], opts);
    await runGit(['add', '-A'], opts);
    await runGit(
      ['-c', 'user.name=probe', '-c', 'user.email=p@x.invalid', 'commit', '-qm', 'two'],
      opts,
    );
    for (const name of markers) expect(ran(name), name).toBe(false);

    // The planted config is live: git without the overrides runs it.
    await appendFile(join(repo, 'a.txt'), 'again\n');
    plainGit(['status', '--short']);
    plainGit(['diff']);
    plainGit(['commit', '-qam', 'three']);
    expect(ran('fsmonitor')).toBe(true);
    expect(ran('extdiff')).toBe(true);
    expect(ran('hook')).toBe(true);
  });
});

/**
 * A commit or push the person starts from the app runs their hooks, as a
 * terminal would. Skipping them sent Git LFS pointers without objects
 * (`pre-push` uploads them) and bypassed pre-commit secret scanners. fsmonitor
 * stays off either way.
 */
describe.runIf(gitAvailable)('runGit for a commit the person started', () => {
  let root: string;
  let repo: string;
  let env: Record<string, string>;
  const ran = (name: string) => existsSync(join(root, `RAN-${name}`));

  function plainGit(args: string[]) {
    return spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000, env });
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-rungit-person-'));
    repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    await writeFile(join(root, 'empty.gitconfig'), '');
    env = {
      ...(process.env as Record<string, string>),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'),
    };
    plainGit(['init', '-q']);
    await writeFile(join(repo, 'a.txt'), 'hi\n');
    plainGit(['add', 'a.txt']);
    plainGit(['-c', 'user.name=probe', '-c', 'user.email=p@x.invalid', 'commit', '-qm', 'init']);
    await appendFile(
      join(repo, '.git', 'config'),
      ['[core]', '\tfsmonitor = "touch ../RAN-fsmonitor; false"', ''].join('\n'),
    );
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\ntouch ../RAN-hook\n');
    await chmod(hook, 0o755);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs the repository hooks, and still never fsmonitor', async () => {
    const commit = ['-c', 'user.name=probe', '-c', 'user.email=p@x.invalid', 'commit'];
    await appendFile(join(repo, 'a.txt'), 'gezel\n');
    await runGit(['add', '-A'], { cwd: repo, env });
    await runGit([...commit, '-qm', 'by a gezel'], { cwd: repo, env });
    expect(ran('hook')).toBe(false);

    await appendFile(join(repo, 'a.txt'), 'person\n');
    await runGit(['add', '-A'], { cwd: repo, env });
    await runGit([...commit, '-qm', 'by the person'], { cwd: repo, env, personStarted: true });
    expect(ran('hook')).toBe(true);
    expect(ran('fsmonitor')).toBe(false);
  });
});
