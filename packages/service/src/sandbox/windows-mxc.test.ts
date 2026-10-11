import { afterEach, describe, expect, it } from 'vitest';
import {
  MXC_MAX_CONCURRENT_ENV,
  MxcPolicyError,
  acquireWindowsMxcSlot,
  buildMxcRequest,
  containerEnvironment,
  describeMxcLaunchFailure,
  windowsCommandLine,
  wrapForWindowsMxc,
} from './windows-mxc.js';

describe('windowsCommandLine', () => {
  it('leaves plain arguments bare and quotes spaces', () => {
    expect(windowsCommandLine(['C:\\Program Files\\nodejs\\node.exe', '-v'])).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" -v',
    );
  });

  it('escapes quotes and the backslashes that precede them', () => {
    expect(windowsCommandLine(['say "hi"'])).toBe('"say \\"hi\\""');
    expect(windowsCommandLine(['a\\"b'])).toBe('"a\\\\\\"b"');
  });

  it('doubles trailing backslashes inside a quoted argument', () => {
    expect(windowsCommandLine(['C:\\some dir\\'])).toBe('"C:\\some dir\\\\"');
  });

  it('keeps backslashes that precede no quote and quotes an empty argument', () => {
    expect(windowsCommandLine(['C:\\a\\b', ''])).toBe('C:\\a\\b ""');
  });
});

describe('buildMxcRequest', () => {
  const base = {
    command: 'C:\\gezel\\bin\\node.exe',
    args: ['--permission', 'C:\\work\\entry.mjs'],
    cwd: 'C:\\work',
    readwritePaths: ['C:\\work', 'C:\\scratch', 'C:\\work\\'],
    readonlyPaths: ['C:\\work', 'C:\\artifacts', 'C:\\gezel\\bin\\node.exe'],
    env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
  };
  const hostEnv = { SYSTEMROOT: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const build = (overrides: Partial<Parameters<typeof buildMxcRequest>[0]> = {}) =>
    buildMxcRequest({ ...base, denyNet: true, ...overrides }, {}, hostEnv);

  it('denies egress, host loopback and inbound for denyNet work', () => {
    expect(build().network).toEqual({
      egress: { default: 'deny' },
      ingress: { default: 'deny', hostLoopback: 'deny' },
    });
  });

  it('allows egress only, never host loopback, for network work', () => {
    const request = build({ denyNet: false });
    expect(request.network.egress).toEqual({ default: 'allow' });
    expect(request.network.ingress).toEqual({ default: 'deny', hostLoopback: 'deny' });
  });

  it('grants writes once and never repeats a writable path as read-only', () => {
    const { filesystem } = build();
    expect(filesystem.readwritePaths).toEqual(['C:\\work', 'C:\\scratch']);
    expect(filesystem.readonlyPaths).toEqual(['C:\\artifacts', 'C:\\gezel\\bin\\node.exe']);
  });

  it('keeps Win32k for Node but no clipboard, injection or DACL fallback', () => {
    const request = build();
    expect(request.ui).toEqual({ disable: false, clipboard: 'none', injection: false });
    expect(request.fallback).toEqual({ allowDaclMutation: false });
  });

  it('adds only the variables the container requires, matching names case-insensitively', () => {
    expect(build().process.env).toEqual([
      'PATH=C:\\Windows',
      'SystemRoot=C:\\Windows',
      'LOCALAPPDATA=C:\\Users\\u\\AppData\\Local',
    ]);
  });

  it('backstops the runner deadline, and a run without one, and quotes the command line', () => {
    expect(build({ timeoutMs: 30_000 }).process.timeout).toBe(35_000);
    expect(build().process.timeout).toBe(30 * 60_000 + 5_000);
    expect(build().process.commandLine).toBe(
      'C:\\gezel\\bin\\node.exe --permission C:\\work\\entry.mjs',
    );
    expect(build().containerId).toMatch(/^gezel-[0-9a-f-]{36}$/);
  });
});

describe('grant guards', () => {
  const policy = {
    command: 'C:\\gezel\\bin\\node.exe',
    args: [],
    cwd: 'C:\\work',
    readwritePaths: ['C:\\work'],
    readonlyPaths: [],
    env: {},
    denyNet: true,
  };

  it.each([
    ['a drive root', 'C:\\'],
    ['a drive root without a slash', 'd:'],
    ['a long-path drive root', '\\\\?\\C:\\'],
    ['a share root', '\\\\server\\share'],
    ['a server root', '\\\\server\\'],
  ])('refuses %s, which opens the whole volume', (_label, root) => {
    expect(() => buildMxcRequest({ ...policy, readonlyPaths: [root] })).toThrow(MxcPolicyError);
  });

  it('refuses a grant that contains a private root, however it is spelled', () => {
    const guards = { privateRoots: ['C:\\Users\\Ada'] };
    expect(() => buildMxcRequest({ ...policy, readonlyPaths: ['c:/users/ada/'] }, guards)).toThrow(
      /contains C:\\Users\\Ada/,
    );
    expect(() => buildMxcRequest({ ...policy, readonlyPaths: ['C:\\Users'] }, guards)).toThrow(
      MxcPolicyError,
    );
  });

  it('allows folders inside a private root and siblings that only share a prefix', () => {
    const guards = { privateRoots: ['C:\\Users\\Ada'] };
    expect(() =>
      buildMxcRequest(
        {
          ...policy,
          readonlyPaths: ['C:\\Users\\Ada\\.gezel\\projects\\p\\workspace', 'C:\\Users\\Adam'],
        },
        guards,
      ),
    ).not.toThrow();
  });

  it('refuses write access over the launcher or the node binary, but not reads', () => {
    const guards = { protectedPaths: ['C:\\gezel\\bin\\node.exe'] };
    expect(() =>
      buildMxcRequest({ ...policy, readwritePaths: ['C:\\gezel\\bin'] }, guards),
    ).toThrow(/refusing write access/);
    expect(() =>
      buildMxcRequest({ ...policy, readonlyPaths: ['C:\\gezel\\bin\\node.exe'] }, guards),
    ).not.toThrow();
  });

  it('refuses a request too long for one Windows command line', () => {
    const many = Array.from({ length: 1_000 }, (_, i) => `C:\\work\\deep\\folder\\number-${i}`);
    expect(() =>
      wrapForWindowsMxc('C:\\mxc\\wxc-exec.exe', { ...policy, readonlyPaths: many }, {}),
    ).toThrow(/32,000/);
  });
});

describe('containerEnvironment', () => {
  it('points temp at scratch and drops PATH, whatever the case', () => {
    expect(
      containerEnvironment(
        { Path: 'C:\\Windows', PATHEXT: '.EXE', temp: 'C:\\Temp', TMPDIR: 'x', HOME: 'C:\\h' },
        'C:\\scratch',
      ),
    ).toEqual({ HOME: 'C:\\h', TEMP: 'C:\\scratch', TMP: 'C:\\scratch' });
  });
});

describe('describeMxcLaunchFailure', () => {
  it('explains a Node that cannot start for want of a desktop', () => {
    expect(describeMxcLaunchFailure(3221225794, '')).toMatch(/no desktop/);
    expect(describeMxcLaunchFailure(-1073741502, '')).toMatch(/no desktop/);
  });

  // Shapes captured from wxc-exec 1.0.0.
  it('reports the launcher error object it ends with', () => {
    const stderr =
      'CreateProcessW failed with error code 2 (0x00000002).{"error":{"code":"backend_error","extended_error":"CreateProcessW(PROC_THREAD_ATTRIBUTE_SECURITY_ENVIRONMENT) failed: WIN32_ERROR(2)","message":"CreateProcessW failed with error code 2 (0x00000002)."}}\n';
    expect(describeMxcLaunchFailure(4294967295, stderr)).toBe(
      'the Windows sandbox failed to start (backend_error): CreateProcessW failed with error code 2 (0x00000002).',
    );
  });

  it('reports a request the launcher refused before starting anything', () => {
    const stderr =
      'Request error\nConfiguration parse error: Invalid one-shot request: unknown field `isolation`\n';
    expect(describeMxcLaunchFailure(1, stderr)).toBe(
      'the Windows sandbox rejected its request: Configuration parse error: Invalid one-shot request: unknown field `isolation`',
    );
  });

  it('leaves a script that merely printed similar JSON alone', () => {
    const stderr = '{"error":{"code":"x","message":"y"}}\nthen the script went on\n';
    expect(describeMxcLaunchFailure(1, stderr)).toBeNull();
    expect(describeMxcLaunchFailure(1, 'TypeError: boom\n')).toBeNull();
  });
});

describe('acquireWindowsMxcSlot', () => {
  const saved = process.env[MXC_MAX_CONCURRENT_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[MXC_MAX_CONCURRENT_ENV];
    else process.env[MXC_MAX_CONCURRENT_ENV] = saved;
  });

  it('queues past the cap, hands the slot on, and lets an abort leave the queue', async () => {
    process.env[MXC_MAX_CONCURRENT_ENV] = '1';
    const first = await acquireWindowsMxcSlot();
    expect(first).toBeTypeOf('function');

    const controller = new AbortController();
    const abandoned = acquireWindowsMxcSlot(controller.signal);
    let secondGranted = false;
    const second = acquireWindowsMxcSlot().then((release) => {
      secondGranted = true;
      return release;
    });
    controller.abort();
    expect(await abandoned).toBeNull();
    expect(secondGranted).toBe(false);

    first?.();
    first?.();
    const release = await second;
    expect(secondGranted).toBe(true);
    release?.();
    expect(await acquireWindowsMxcSlot(AbortSignal.abort())).toBeNull();
  });
});
