import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionResumeError } from '../types.js';
import {
  buildCodexArgs,
  classifyError,
  permissionModeToCodexArgs,
  quoteForWindowsShell,
  runCodexTurn,
} from './invoker.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-codex-invoker-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Build a fake `codex` binary that writes a scripted NDJSON sequence to
 * stdout and exits with the given code. The script ignores its argv —
 * the invoker test asserts argv composition separately via
 * `buildCodexArgs`.
 *
 * Cross-platform: a POSIX shell script with a shebang on Linux/macOS, a
 * `.cmd` wrapper on Windows. The Windows path uses sidecar files +
 * `type` rather than `<NUL set /p =` because the invoker's stdout is
 * multi-line NDJSON and the set/p trick can't preserve internal
 * newlines.
 */
async function makeFakeCodex(stdout: string, exitCode = 0, stderr = ''): Promise<string> {
  if (process.platform === 'win32') {
    const stdoutFile = join(dir, 'codex.stdout');
    const stderrFile = join(dir, 'codex.stderr');
    await writeFile(stdoutFile, stdout, 'utf8');
    if (stderr) await writeFile(stderrFile, stderr, 'utf8');
    const path = join(dir, 'codex.cmd');
    const lines = ['@echo off', `type "${stdoutFile}"`];
    if (stderr) lines.push(`type "${stderrFile}" 1>&2`);
    lines.push(`exit /b ${exitCode}`, '');
    await writeFile(path, lines.join('\r\n'), 'utf8');
    return path;
  }
  const path = join(dir, 'codex');
  // shell-escape the literal payloads through env vars so quoting in
  // NDJSON / multi-line content survives.
  const stdoutVar = stdout.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const stderrVar = stderr.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const script = `#!/bin/sh
printf "%s" "${stdoutVar}"
${stderr ? `printf "%s" "${stderrVar}" 1>&2` : ''}
exit ${exitCode}
`;
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return path;
}

describe('permissionModeToCodexArgs', () => {
  it('maps default → workspace-write sandbox with non-interactive approvals', () => {
    expect(permissionModeToCodexArgs('default')).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
    ]);
  });

  it('maps acceptEdits → workspace-write sandbox with non-interactive approvals', () => {
    expect(permissionModeToCodexArgs('acceptEdits')).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
    ]);
  });

  it('maps plan → read-only sandbox + never approval', () => {
    expect(permissionModeToCodexArgs('plan')).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
    ]);
  });

  it('maps bypassPermissions → --dangerously-bypass-approvals-and-sandbox', () => {
    expect(permissionModeToCodexArgs('bypassPermissions')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });
});

describe('buildCodexArgs', () => {
  it('builds the canonical first-turn argv', () => {
    const args = buildCodexArgs({
      prompt: 'hi there',
      model: 'gpt-5.5',
      permissionMode: 'acceptEdits',
      cwd: '/tmp/work',
    });
    expect(args).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      '/tmp/work',
      '-m',
      'gpt-5.5',
      'hi there',
    ]);
  });

  it('omits --ephemeral so the rollout persists for `codex exec resume`', () => {
    // Without a persistent rollout, the next turn's `exec resume` would
    // die with `no rollout found for thread id …` and break multi-turn
    // entirely. The duplicate-state cost is bounded by per-session
    // CODEX_HOME teardown.
    const args = buildCodexArgs({
      prompt: 'hi',
      model: 'gpt-5.5',
      permissionMode: 'acceptEdits',
      cwd: '/tmp/work',
    });
    expect(args).not.toContain('--ephemeral');
  });

  it('builds a resume argv that preserves model, permissions, and config but omits --cd', () => {
    // Current Codex accepts these execution-shaping flags on resume.
    // Repeating them prevents follow-up eval turns from falling back to
    // a default read-only sandbox. `--cd` is still not accepted; the
    // child process cwd anchors the workspace instead.
    const args = buildCodexArgs({
      prompt: 'follow-up',
      model: 'gpt-5.5',
      permissionMode: 'bypassPermissions',
      cwd: '/tmp/work',
      reasoningEffort: 'high',
      extraConfigOverrides: { 'web_search.live': 'true' },
      resumeThreadId: 'thread-abc',
    });
    expect(args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="high"',
      '-c',
      'web_search.live=true',
      'thread-abc',
      'follow-up',
    ]);
    expect(args).not.toContain('--cd');
  });

  it('passes image attachments before positional prompt/session args', () => {
    const first = buildCodexArgs({
      prompt: 'describe these',
      model: 'gpt-5.5',
      permissionMode: 'acceptEdits',
      cwd: '/tmp/work',
      imagePaths: ['/tmp/a.png', '/tmp/b.jpg'],
    });
    expect(first).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      '/tmp/work',
      '-m',
      'gpt-5.5',
      '--image',
      '/tmp/a.png',
      '--image',
      '/tmp/b.jpg',
      'describe these',
    ]);

    const resumed = buildCodexArgs({
      prompt: 'follow up',
      model: 'gpt-5.5',
      permissionMode: 'acceptEdits',
      cwd: '/tmp/work',
      imagePaths: ['/tmp/a.png'],
      resumeThreadId: 'thread-abc',
    });
    expect(resumed.slice(-4)).toEqual(['--image', '/tmp/a.png', 'thread-abc', 'follow up']);
  });

  it('forwards reasoning effort via -c', () => {
    const args = buildCodexArgs({
      prompt: 'p',
      model: 'gpt-5.5',
      permissionMode: 'acceptEdits',
      cwd: '/x',
      reasoningEffort: 'high',
    });
    const idx = args.indexOf('-c');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('model_reasoning_effort="high"');
  });

  it('appends extra config overrides verbatim', () => {
    const args = buildCodexArgs({
      prompt: 'p',
      model: 'gpt-5.5',
      permissionMode: 'acceptEdits',
      cwd: '/x',
      extraConfigOverrides: { 'web_search.live': 'true', personality: '"friendly"' },
    });
    expect(args).toContain('-c');
    expect(args).toContain('web_search.live=true');
    expect(args).toContain('personality="friendly"');
  });
});

describe('quoteForWindowsShell', () => {
  it('leaves bare arguments untouched', () => {
    expect(quoteForWindowsShell('--json')).toBe('--json');
    expect(quoteForWindowsShell('gpt-5.5')).toBe('gpt-5.5');
    expect(quoteForWindowsShell('thread-abc')).toBe('thread-abc');
  });

  it('wraps multi-word prompts in double quotes', () => {
    // Without this, cmd.exe word-splits the prompt and codex sees the
    // second word as `unexpected argument 'there'`.
    expect(quoteForWindowsShell('hi there')).toBe('"hi there"');
  });

  it('quotes paths containing spaces', () => {
    expect(quoteForWindowsShell('C:\\Users\\Dev\\My Project')).toBe('"C:\\Users\\Dev\\My Project"');
  });

  it('doubles inner double quotes per cmd.exe parsing rules', () => {
    expect(quoteForWindowsShell('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes the empty string as ""', () => {
    expect(quoteForWindowsShell('')).toBe('""');
  });

  it('quotes shell metacharacters', () => {
    expect(quoteForWindowsShell('a&b')).toBe('"a&b"');
    expect(quoteForWindowsShell('a|b')).toBe('"a|b"');
    expect(quoteForWindowsShell('a>b')).toBe('"a>b"');
  });
});

describe('classifyError', () => {
  it('returns a SessionResumeError when an attempted-resume turn dies before thread.started with a resume signal', () => {
    const err = classifyError({
      message: 'thread not found',
      stderr: '',
      attemptedResume: true,
      threadStarted: false,
    });
    expect(err).toBeInstanceOf(SessionResumeError);
  });

  it("matches Codex's exact `no rollout found …` wording (stale --ephemeral thread id recovery)", () => {
    const err = classifyError({
      message:
        'thread/resume: thread/resume failed: no rollout found for thread id 019e6086-7f7e-7f90-a72d-a8abc8989294 (code -32600)',
      stderr: '',
      attemptedResume: true,
      threadStarted: false,
    });
    expect(err).toBeInstanceOf(SessionResumeError);
  });

  it('does NOT return a SessionResumeError when a thread had already started', () => {
    const err = classifyError({
      message: 'thread not found',
      stderr: '',
      attemptedResume: true,
      threadStarted: true,
    });
    expect(err).not.toBeInstanceOf(SessionResumeError);
  });

  it('does NOT return a SessionResumeError on a fresh-thread turn', () => {
    const err = classifyError({
      message: 'thread not found',
      stderr: '',
      attemptedResume: false,
      threadStarted: false,
    });
    expect(err).not.toBeInstanceOf(SessionResumeError);
  });

  it('returns a plain error for unrelated failures', () => {
    const err = classifyError({
      message: 'rate limited',
      stderr: '',
      attemptedResume: true,
      threadStarted: false,
    });
    expect(err).not.toBeInstanceOf(SessionResumeError);
    expect(err.message).toContain('rate limited');
  });
});

describe('runCodexTurn — happy path', () => {
  it('drives a scripted codex through to completion', async () => {
    const ndjson = [
      '{"type":"thread.started","thread_id":"thr-42"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"i1","type":"agent_message"}}',
      '{"type":"item.updated","item":{"id":"i1","type":"agent_message","text":"Hello, "}}',
      '{"type":"item.updated","item":{"id":"i1","type":"agent_message","text":"Hello, world."}}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hello, world."}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":3,"output_tokens":5}}',
      '',
    ].join('\n');
    const codex = await makeFakeCodex(ndjson);

    const deltas: string[] = [];
    let capturedThreadId: string | null = null;
    const usages: Array<{ inputTokens: number; outputTokens: number }> = [];

    const result = await runCodexTurn({
      binaryPath: codex,
      cwd: dir,
      codexHome: join(dir, 'codex-home'),
      baseEnv: { ...process.env, CODEX_API_KEY: 'fake' },
      model: 'gpt-5.5',
      permissionMode: 'acceptEdits',
      prompt: 'hi',
      hooks: {
        emitDelta: (text) => deltas.push(text),
        emitIntent: () => {},
        emitHeartbeat: () => {},
        emitUsage: (u) => usages.push({ inputTokens: u.inputTokens, outputTokens: u.outputTokens }),
        emitWarning: () => {},
        onThreadStarted: (id) => {
          capturedThreadId = id;
        },
      },
    });

    expect(result).toBe('Hello, world.');
    expect(capturedThreadId).toBe('thr-42');
    expect(deltas.join('')).toBe('Hello, world.');
    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('emits richer tool-call telemetry for completed Codex tool items', async () => {
    const ndjson = [
      '{"type":"thread.started","thread_id":"thr-42"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"t1","type":"command_execution","command":"pnpm test","cwd":"/tmp/work"}}',
      '{"type":"item.completed","item":{"id":"t1","type":"command_execution","command":"pnpm test","cwd":"/tmp/work","status":"completed","exit_code":0,"output":"ok"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":3,"output_tokens":5}}',
      '',
    ].join('\n');
    const codex = await makeFakeCodex(ndjson);
    const toolCalls: Array<{
      name: string;
      args?: Record<string, unknown>;
      structuredContent?: Record<string, unknown>;
      resultText?: string;
      success: boolean;
    }> = [];

    await runCodexTurn({
      binaryPath: codex,
      cwd: dir,
      codexHome: join(dir, 'codex-home'),
      baseEnv: { ...process.env, CODEX_API_KEY: 'fake' },
      model: 'gpt-5.5',
      permissionMode: 'acceptEdits',
      prompt: 'hi',
      hooks: {
        emitDelta: () => {},
        emitIntent: () => {},
        emitHeartbeat: () => {},
        emitUsage: () => {},
        emitWarning: () => {},
        onToolCall: (ev) => {
          toolCalls.push({
            name: ev.name,
            args: ev.args,
            structuredContent: ev.structuredContent,
            resultText: ev.resultText,
            success: ev.success,
          });
        },
      },
    });

    expect(toolCalls).toEqual([
      {
        name: 'shell',
        args: {
          command: 'pnpm test',
          cwd: '/tmp/work',
          status: 'completed',
          exitCode: 0,
          outputPreview: 'ok',
        },
        structuredContent: { status: 'completed', exitCode: 0, outputPreview: 'ok' },
        resultText: 'ok',
        success: true,
      },
    ]);
  });

  it('rejects with SessionResumeError when a resume turn dies before thread.started', async () => {
    // No NDJSON emitted; non-zero exit with a stderr matching the
    // resume-failure signal.
    const codex = await makeFakeCodex('', 2, 'thread not found in rollouts');
    await expect(
      runCodexTurn({
        binaryPath: codex,
        cwd: dir,
        codexHome: join(dir, 'codex-home'),
        baseEnv: { ...process.env, CODEX_API_KEY: 'fake' },
        model: 'gpt-5.5',
        permissionMode: 'acceptEdits',
        prompt: 'follow-up',
        resumeThreadId: 'old-thread',
        hooks: {
          emitDelta: () => {},
          emitIntent: () => {},
          emitHeartbeat: () => {},
          emitUsage: () => {},
          emitWarning: () => {},
        },
      }),
    ).rejects.toBeInstanceOf(SessionResumeError);
  });

  it('rejects with a plain error on non-zero exit with no recognizable resume signal', async () => {
    const codex = await makeFakeCodex('', 1, 'rate limited');
    await expect(
      runCodexTurn({
        binaryPath: codex,
        cwd: dir,
        codexHome: join(dir, 'codex-home'),
        baseEnv: { ...process.env, CODEX_API_KEY: 'fake' },
        model: 'gpt-5.5',
        permissionMode: 'acceptEdits',
        prompt: 'hi',
        hooks: {
          emitDelta: () => {},
          emitIntent: () => {},
          emitHeartbeat: () => {},
          emitUsage: () => {},
          emitWarning: () => {},
        },
      }),
    ).rejects.toThrow(/rate limited/);
  });
});
