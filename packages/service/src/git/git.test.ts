import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { runGit } = await import('./git.js');

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('runGit process safety', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('forces terminal and Git Credential Manager interaction off', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = runGit(['fetch', 'origin'], {
      env: {
        GIT_TERMINAL_PROMPT: '1',
        GCM_INTERACTIVE: '1',
        GCM_GUI_PROMPT: '1',
      },
    });
    queueMicrotask(() => child.emit('close', 0));
    await pending;

    expect(spawnMock).toHaveBeenCalledOnce();
    const [command, args, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe('git');
    expect(args).toEqual([
      '-c',
      'safe.bareRepository=all',
      '-c',
      'credential.interactive=false',
      'fetch',
      'origin',
    ]);
    expect(options).toEqual(
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '/bin/true',
          GCM_INTERACTIVE: '0',
          GCM_GUI_PROMPT: '0',
        }),
      }),
    );
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it('writes an optional bulk-input payload to stdin and closes it', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = runGit(['check-ignore', '--stdin'], { stdin: 'dist/a.js\0' });
    queueMicrotask(() => child.emit('close', 0));
    await pending;

    expect(spawnMock.mock.calls[0]![2]).toEqual(
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(child.stdin.end).toHaveBeenCalledWith('dist/a.js\0');
  });

  it('contains an stdin EPIPE when Git rejects bulk input before consuming it', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = runGit(['check-ignore', '--stdin'], { stdin: 'dist/a.js\0' });
    queueMicrotask(() => {
      child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      child.stderr.emit('data', Buffer.from('fatal: not a git repository'));
      child.emit('close', 128);
    });

    await expect(pending).rejects.toMatchObject({
      name: 'GitError',
      code: 128,
      stderr: 'fatal: not a git repository',
    });
  });

  it.each([
    ['ordinary', ['clone', 'https://github.com/o/r.git', '/tmp/worktree']],
    ['bare', ['clone', '--bare', '--filter=blob:none', 'https://github.com/o/r.git', '/tmp/bare']],
  ])(
    'keeps a GitHub token out of spawned argv for an authenticated %s clone',
    async (_kind, cloneArgs) => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const sentinel = 'GEZEL_CLONE_AUTH_SENTINEL';

      const pending = runGit(
        ['-c', `http.extraheader=AUTHORIZATION: Bearer ${sentinel}`, ...cloneArgs],
        { redact: [sentinel] },
      );
      queueMicrotask(() => child.emit('close', 0));
      await pending;

      const [command, spawnedArgs, options] = spawnMock.mock.calls[0]!;
      expect(command).toBe('git');
      expect(spawnedArgs).toEqual([
        '-c',
        'safe.bareRepository=all',
        '-c',
        'credential.interactive=false',
        ...cloneArgs,
      ]);
      expect(spawnedArgs.join(' ')).not.toContain(sentinel);
      expect(spawnedArgs.join(' ')).not.toContain('http.extraheader');
      expect(options.env).toEqual(
        expect.objectContaining({
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraheader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: Bearer ${sentinel}`,
        }),
      );
    },
  );

  it('redacts an authenticated clone token from a failing git error', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const sentinel = 'GEZEL_FAILING_CLONE_AUTH_SENTINEL';

    const pending = runGit(
      [
        '-c',
        `http.extraheader=AUTHORIZATION: Bearer ${sentinel}`,
        'clone',
        'https://github.com/o/r.git',
        '/tmp/worktree',
      ],
      { redact: [sentinel] },
    );
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from(`fatal: rejected Bearer ${sentinel}`));
      child.emit('close', 128);
    });

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(sentinel);
    expect((error as { stderr: string }).stderr).not.toContain(sentinel);
    expect((error as Error).message).toContain('***');
  });
});
