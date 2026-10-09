import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type RestrictedGitSubcommand,
  restrictedGitArgv,
  restrictedGitEnv,
} from './restricted-args.js';

function allowed(subcommand: RestrictedGitSubcommand, args: string[]): boolean {
  return 'argv' in restrictedGitArgv(subcommand, args);
}

describe('restrictedGitArgv allowlist', () => {
  it.each<[RestrictedGitSubcommand, string[]]>([
    ['status', []],
    ['status', ['--short']],
    ['status', ['-sb']],
    ['status', ['--porcelain=v2', '--branch']],
    ['status', ['-uno']],
    ['log', ['--oneline', '-n', '5']],
    ['log', ['-5', '--stat']],
    ['log', ['--format=%H %s', '--since=2.weeks', '--author', 'Ana']],
    ['log', ['main..feature']],
    ['log', ['origin/main...HEAD', '--', 'src/app.ts']],
    ['log', ['-p', '-M50%', '--follow', 'src/app.ts']],
    ['diff', ['--stat', 'HEAD~1']],
    ['diff', ['--cached', '--name-only']],
    ['diff', ['-U5', '--word-diff=color']],
    ['show', ['HEAD:src/app.ts']],
    ['show', ['--name-status', 'HEAD']],
    ['blame', ['-L', '1,5', 'src/app.ts']],
    ['blame', ['--porcelain', '-w', 'src/app.ts']],
    ['branch', []],
    ['branch', ['--show-current']],
    ['branch', ['-d', 'old-topic']],
    ['branch', ['--format=%(refname:short)', '--sort=-committerdate']],
    ['rev-parse', ['--abbrev-ref', 'HEAD']],
    ['rev-parse', ['--short=8', 'HEAD']],
    ['ls-files', ['-co', '--exclude-standard']],
    ['ls-files', ['--', 'src']],
  ])('allows git %s %j', (subcommand, args) => {
    expect(restrictedGitArgv(subcommand, args)).toHaveProperty('argv');
  });

  it.each<[RestrictedGitSubcommand, string[], RegExp]>([
    ['log', ['--output=/tmp/pwned', '--format=x'], /not allowed/],
    ['log', ['--out=/tmp/pwned'], /not allowed/],
    ['show', ['--output', '/tmp/pwned'], /not allowed/],
    ['diff', ['--no-index', 'a.txt', 'b.txt'], /not allowed/],
    ['diff', ['--ext-diff'], /not allowed/],
    ['diff', ['--textconv'], /not allowed/],
    ['log', ['--show-signature'], /not allowed/],
    ['blame', ['--contents', '/etc/passwd', 'src/app.ts'], /not allowed/],
    ['blame', ['--ignore-revs-file=/etc/passwd', 'src/app.ts'], /not allowed/],
    ['branch', ['--edit-description'], /not allowed/],
    ['branch', ['--set-upstream-to=origin/main'], /not allowed/],
    ['ls-files', ['--exclude-from=/etc/passwd'], /not allowed/],
    ['ls-files', ['-X', 'patterns'], /not allowed/],
    ['rev-parse', ['--resolve-git-dir', 'x'], /not allowed/],
    ['log', ['-c', 'core.pager=sh'], /not allowed/],
    ['log', ['--exec=sh'], /not allowed/],
    ['status', ['-sz', '-x'], /not allowed/],
    ['diff', ['/etc/passwd', '/dev/null'], /absolute path/],
    ['diff', ['C:\\Windows\\win.ini', 'x'], /absolute path/],
    ['diff', ['~/.ssh/id_ed25519', 'x'], /absolute path/],
    ['diff', ['../../.gezel/runtime/auth-token', 'x'], /\.\./],
    ['log', ['--', 'src/../../secret'], /\.\./],
    ['log', ['--author'], /needs a value/],
    ['log', ['line\nbreak'], /newlines/],
  ])('refuses git %s %j', (subcommand, args, message) => {
    const result = restrictedGitArgv(subcommand, args);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(message);
  });

  it('consumes a separated option value, so it is never read as a flag or path', () => {
    expect(allowed('log', ['--grep', '-not-a-flag'])).toBe(true);
    expect(allowed('log', ['-S', '../not-a-path'])).toBe(true);
  });

  it('prefixes hardening config and forces off external diff programs', () => {
    const status = restrictedGitArgv('status', ['--short']);
    expect(status).toEqual({
      argv: expect.arrayContaining(['-c', 'core.fsmonitor=false', 'status', '--short']),
    });
    const argv = (restrictedGitArgv('diff', ['--stat']) as { argv: string[] }).argv;
    expect(argv.slice(0, 4)).toEqual(['-c', 'core.fsmonitor=false', '-c', argv[3]]);
    expect(argv[3]).toMatch(/^core\.hooksPath=/);
    expect(argv.slice(4)).toEqual(['diff', '--no-ext-diff', '--no-textconv', '--stat']);
    const blame = (restrictedGitArgv('blame', ['a.txt']) as { argv: string[] }).argv;
    expect(blame.slice(4)).toEqual(['blame', '--no-textconv', 'a.txt']);
  });

  it('strips GIT_* redirections from the environment', () => {
    const env = restrictedGitEnv({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      GIT_DIR: '/elsewhere/.git',
      GIT_EXTERNAL_DIFF: 'sh -c pwn',
      git_work_tree: '/elsewhere',
    });
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/dev', GIT_TERMINAL_PROMPT: '0' });
    expect(env).not.toHaveProperty('GIT_DIR');
    expect(env).not.toHaveProperty('GIT_EXTERNAL_DIFF');
    expect(env).not.toHaveProperty('git_work_tree');
  });
});

const gitAvailable = spawnSync('git', ['--version']).status === 0;

describe.runIf(gitAvailable && process.platform !== 'win32')(
  'restricted git against a repository whose config runs programs',
  () => {
    let root: string;
    let repo: string;
    const markers = ['PWNED-fsmonitor', 'PWNED-extdiff', 'PWNED-textconv', 'PWNED-hook'];

    function git(args: string[], env = restrictedGitEnv(process.env)) {
      return spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    }

    async function probeScript(name: string, body: string): Promise<string> {
      const path = join(root, 'bin', name);
      await writeFile(path, `#!/bin/sh\n${body}\n`);
      await chmod(path, 0o755);
      return path;
    }

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'gezel-restricted-git-'));
      repo = join(root, 'repo');
      await mkdir(join(root, 'bin'), { recursive: true });
      await mkdir(repo, { recursive: true });
      const plain = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      };
      git(['init', '-q'], plain);
      git(['config', 'user.email', 'probe@example.invalid'], plain);
      git(['config', 'user.name', 'probe'], plain);
      await writeFile(join(repo, 'a.txt'), 'hi\n');
      git(['add', 'a.txt'], plain);
      git(['commit', '-qm', 'init'], plain);
      await appendFile(join(repo, 'a.txt'), 'bye\n');

      const fsmonitor = await probeScript(
        'fsmonitor.sh',
        `touch '${join(root, 'PWNED-fsmonitor')}'\nexit 1`,
      );
      const extdiff = await probeScript('extdiff.sh', `touch '${join(root, 'PWNED-extdiff')}'`);
      const textconv = await probeScript(
        'textconv.sh',
        `touch '${join(root, 'PWNED-textconv')}'\ncat "$1"`,
      );
      await appendFile(
        join(repo, '.git', 'config'),
        [
          '[core]',
          `\tfsmonitor = ${fsmonitor}`,
          '[diff]',
          `\texternal = ${extdiff}`,
          '[diff "probe"]',
          `\ttextconv = ${textconv}`,
          '',
        ].join('\n'),
      );
      await writeFile(join(repo, '.gitattributes'), '*.txt diff=probe\n');
      const hooks = join(repo, '.git', 'hooks');
      await mkdir(hooks, { recursive: true });
      await writeFile(
        join(hooks, 'reference-transaction'),
        `#!/bin/sh\ntouch '${join(root, 'PWNED-hook')}'\n`,
      );
      await chmod(join(hooks, 'reference-transaction'), 0o755);
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('runs none of the configured programs for any allowed subcommand', () => {
      const runs: Array<[RestrictedGitSubcommand, string[]]> = [
        ['status', ['--short']],
        ['diff', []],
        ['log', ['-p', '-1']],
        ['show', ['HEAD']],
        ['blame', ['a.txt']],
        ['branch', ['probe-branch']],
        ['ls-files', []],
        ['rev-parse', ['HEAD']],
      ];
      for (const [subcommand, args] of runs) {
        const plan = restrictedGitArgv(subcommand, args);
        if (!('argv' in plan)) throw new Error(plan.error);
        const result = git(plan.argv);
        expect(result.status, `${subcommand}: ${result.stderr}`).toBe(0);
      }
      for (const marker of markers) {
        expect(existsSync(join(root, marker)), marker).toBe(false);
      }

      // The planted config is live: plain git runs it.
      git(['status', '--short'], process.env);
      git(['diff'], process.env);
      git(['branch', 'plain-branch'], process.env);
      expect(existsSync(join(root, 'PWNED-fsmonitor'))).toBe(true);
      expect(existsSync(join(root, 'PWNED-extdiff'))).toBe(true);
      expect(existsSync(join(root, 'PWNED-hook'))).toBe(true);
    });
  },
);
