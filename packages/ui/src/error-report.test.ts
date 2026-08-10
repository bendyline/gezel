import type { SystemDiagnostics } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  type ErrorReportInput,
  buildIssueUrl,
  deriveIssueTitle,
  fitIssueUrl,
  formatErrorReport,
  isUserCancelledTurnError,
  reportCursorOffset,
} from './error-report.js';

const GB = 1024 ** 3;

const DIAGNOSTICS: SystemDiagnostics = {
  version: '1.26212.4',
  sampledAt: '2026-07-31T18:32:00Z',
  runtime: {
    nodeVersion: '22.14.0',
    platform: 'linux',
    arch: 'x64',
    osRelease: '6.8.0-51-generic',
    platformKey: 'linux-x64',
  },
  hardware: {
    totalRamBytes: 64 * GB,
    gpuVramBytes: 24 * GB,
    usableBytes: 22.8 * GB,
    source: 'gpu-vulkan',
    gpuVendor: 'amd',
    description: 'AMD GPU: 24.0 GB VRAM …',
    tier: 'medium',
    gpuDevices: [{ name: 'AMD Radeon RX 7900 XTX', totalMiB: 24_560 }],
  },
  engine: {
    nativeRelease: 'native-v0.1.29',
    nativePinned: true,
    installedEngines: ['llama-server'],
    llamaCppBackend: 'vulkan',
    llamaCppRevision: 'b7021',
  },
  models: {
    defaultProvider: 'llama-cpp',
    defaultModel: 'gemma4-26b-q4',
    installed: [{ id: 'gemma4-26b-q4', provider: 'llama-cpp', parameterSize: '26B' }],
  },
};

const SIGILL =
  '[llama-cpp] on-device engine crashed (SIGILL); incident=native-51832-1785547847453. ' +
  'It will restart on the next request.';

function crash(overrides: Partial<ErrorReportInput> = {}): ErrorReportInput {
  return {
    surface: 'chat-turn',
    message: SIGILL,
    detail: {
      code: 'native-engine-crash',
      engine: 'llama-cpp',
      incidentId: 'native-51832-1785547847453',
      panicKind: 'SIGILL',
    },
    diagnostics: DIAGNOSTICS,
    ...overrides,
  };
}

describe('formatErrorReport', () => {
  it('never emits an absolute path, whatever its inputs carry', () => {
    // The privacy invariant. Error strings and dev stack traces are full of
    // home paths, and every home path embeds the OS username.
    const body = formatErrorReport({
      surface: 'tab-crash',
      message: "ENOENT: no such file, open '/Users/mike/.gezel/gezels/g1/about.md'",
      stack: 'at ProjectOverview (/Users/mike/gh/gezel/packages/ui/src/views/X.tsx:118:22)',
      componentStack: '    at TabErrorBoundary (C:\\Users\\Mike\\AppData\\Local\\gezel\\x.js)',
      diagnostics: DIAGNOSTICS,
    });
    expect(body).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\Users\\/);
    expect(body).not.toContain('mike');
    expect(body).not.toContain('Mike');
  });

  it('opens with the user prompt so truncation can never eat it', () => {
    expect(formatErrorReport(crash()).startsWith('### What I was doing')).toBe(true);
  });

  it('carries the error and the structured detail', () => {
    const body = formatErrorReport(crash());
    expect(body).toContain(`### Error\n${SIGILL}\n\n### Details`);
    expect(body).not.toContain('### Error\n\n```text');
    expect(body).toContain('on-device engine crashed');
    expect(body).toContain('code: native-engine-crash');
    expect(body).toContain('engine: llama-cpp');
    expect(body).toContain('incident: native-51832-1785547847453');
    expect(body).toContain('panic: SIGILL');
  });

  it('keeps a multiline error compact and unfenced', () => {
    const body = formatErrorReport(crash({ message: 'first line\nsecond line' }));
    expect(body).toContain('### Error\nfirst line second line\n\n### Details');
    expect(body).not.toContain('```text');
  });

  it('flattens the crash-time launch diagnostics into the details block', () => {
    const body = formatErrorReport(
      crash({
        detail: { code: 'native-engine-crash', diagnostics: { contextTotal: 32768, slots: 1 } },
      }),
    );
    expect(body).toContain('contextTotal: 32768');
    expect(body).toContain('slots: 1');
  });

  it('omits detail lines that are not known, keeping only the surface', () => {
    const body = formatErrorReport({ surface: 'session-error', message: 'boom' });
    expect(body).toContain('surface: session-error');
    expect(body).not.toContain('code:');
    expect(body).not.toContain('engine:');
  });

  it('renders the machine profile', () => {
    const body = formatErrorReport(crash());
    expect(body).toContain('app: 1.26212.4');
    expect(body).toContain('platform: linux x64 (linux-x64) 6.8.0-51-generic');
    expect(body).toContain('memory: 64 GB RAM, 24 GB VRAM (amd)');
    expect(body).toContain('gpu: AMD Radeon RX 7900 XTX');
    expect(body).toContain('llama.cpp: vulkan, b7021');
    expect(body).toContain('models: gemma4-26b-q4 (llama-cpp, 26B)');
    expect(body).toContain('default: llama-cpp / gemma4-26b-q4');
  });

  it('still produces a report when diagnostics could not be fetched', () => {
    // Reporting has to survive a dead service — that is often the bug.
    const body = formatErrorReport(crash({ diagnostics: null }));
    expect(body).toContain('Machine profile unavailable');
    expect(body).toContain('on-device engine crashed');
  });

  it('drops the Error section for the Settings entry point and prompts differently', () => {
    const body = formatErrorReport({
      surface: 'settings-about',
      message: '',
      diagnostics: DIAGNOSTICS,
    });
    expect(body).not.toContain('### Error');
    expect(body).toContain('What went wrong?');
    expect(body).toContain('### Machine');
  });

  it('omits the Stack section unless a trace is present, and caps an oversized one', () => {
    expect(formatErrorReport(crash())).not.toContain('### Stack');
    const body = formatErrorReport(crash({ stack: `Error\n${'  at frame\n'.repeat(500)}` }));
    expect(body).toContain('### Stack');
    expect(body).toContain('… (truncated)');
  });
});

describe('reportCursorOffset', () => {
  it('points at the blank line under the first heading', () => {
    const body = formatErrorReport(crash());
    expect(body.slice(reportCursorOffset(body))).toMatch(/^<!-- One or two lines/);
  });
});

describe('isUserCancelledTurnError', () => {
  it('recognizes the local-provider cancellation wording', () => {
    expect(isUserCancelledTurnError('[Mac AI] turn cancelled by caller')).toBe(true);
    expect(isUserCancelledTurnError('[llama-cpp] turn canceled by caller')).toBe(true);
  });

  it('does not classify a genuine provider failure as user cancellation', () => {
    expect(isUserCancelledTurnError(SIGILL)).toBe(false);
  });
});

describe('deriveIssueTitle', () => {
  it('scopes by engine and names the crash class', () => {
    // The `[llama-cpp]` the message already carries is dropped, not doubled,
    // and the incident's pid + timestamp normalize away so two reports of
    // this crash land on the same title.
    expect(deriveIssueTitle(crash())).toBe(
      '[llama-cpp] on-device engine crashed (SIGILL); incident=native-N-N. It…',
    );
  });

  it('normalizes run-specific noise so duplicates collide in search', () => {
    const a = deriveIssueTitle({
      surface: 'chat-turn',
      message: 'engine died pid 48213 at 0x7ff8ab after 120000ms',
    });
    const b = deriveIssueTitle({
      surface: 'chat-turn',
      message: 'engine died pid 99999 at 0x1122cd after 340000ms',
    });
    expect(a).toBe(b);
  });

  it('does not mangle an engine build tag', () => {
    expect(deriveIssueTitle({ surface: 'chat-turn', message: 'crash in build b7021' })).toContain(
      'b7021',
    );
  });

  it('strips a JS error-class prefix', () => {
    expect(
      deriveIssueTitle({ surface: 'tab-crash', message: "TypeError: Cannot read 'id' of null" }),
    ).toBe("[tab crashed] Cannot read 'id' of null");
  });

  it('falls back to the surface label when there is no message', () => {
    expect(deriveIssueTitle({ surface: 'settings-about', message: '' })).toBe(
      '[problem report] problem report',
    );
  });

  it('caps at 72 characters', () => {
    const title = deriveIssueTitle({ surface: 'chat-turn', message: 'x'.repeat(300) });
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('buildIssueUrl', () => {
  it('targets the repo issue form', () => {
    const url = buildIssueUrl({ title: 't', body: 'b' });
    expect(url.startsWith('https://github.com/bendyline/gezel/issues/new?')).toBe(true);
  });

  it('round-trips a body through the query string byte for byte', () => {
    // `+` is the regression guard: URLSearchParams would encode spaces as
    // `+`, which GitHub renders literally in the issue body.
    const body = '### A\n\n```text\nx & y # z + w\n```\n\nsee `code`';
    const url = buildIssueUrl({ title: 'a b', body });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('body')).toBe(body);
    expect(parsed.searchParams.get('title')).toBe('a b');
  });

  it('labels the issue a bug by default, and honors an override', () => {
    expect(new URL(buildIssueUrl({ title: 't', body: 'b' })).searchParams.get('labels')).toBe(
      'bug',
    );
    expect(
      new URL(buildIssueUrl({ title: 't', body: 'b', labels: ['a', 'b'] })).searchParams.get(
        'labels',
      ),
    ).toBe('a,b');
  });
});

describe('fitIssueUrl', () => {
  it('leaves a report that fits untouched', () => {
    const body = formatErrorReport(crash());
    const { url, truncated } = fitIssueUrl({ title: 't', body });
    expect(truncated).toBe(false);
    expect(new URL(url).searchParams.get('body')).toBe(body);
  });

  it('keeps the head and drops the tail when over the Windows budget', () => {
    const body = formatErrorReport(crash({ stack: `Error\n${'  at frame\n'.repeat(400)}` }));
    const { url, truncated } = fitIssueUrl({ title: 't', body, maxUrlLength: 2000 });
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(2000);
    const kept = new URL(url).searchParams.get('body') ?? '';
    // The user's own words and the error survive; the unbounded tail is what
    // gets cut, and the note tells them where the rest went.
    expect(kept).toContain('### What I was doing');
    expect(kept).toContain('### Error');
    expect(kept).toContain('on your clipboard');
    expect(kept.length).toBeLessThan(body.length);
    const frames = (s: string) => (s.match(/at frame/g) ?? []).length;
    expect(frames(kept)).toBeLessThan(frames(body));
  });

  it('cuts only at line boundaries', () => {
    const body = Array.from({ length: 400 }, (_, i) => `line-${i}-aaaaaaaaaaaaaaaa`).join('\n');
    const { url } = fitIssueUrl({ title: 't', body, maxUrlLength: 2000 });
    const kept = (new URL(url).searchParams.get('body') ?? '').split('\n_This report')[0] ?? '';
    for (const line of kept.split('\n').filter(Boolean)) {
      expect(line).toMatch(/^line-\d+-a{16}$/);
    }
  });

  it('defaults to the roomier non-Windows budget', () => {
    const body = 'x'.repeat(5000);
    expect(fitIssueUrl({ title: 't', body }).truncated).toBe(false);
    expect(fitIssueUrl({ title: 't', body, maxUrlLength: 2000 }).truncated).toBe(true);
  });
});
