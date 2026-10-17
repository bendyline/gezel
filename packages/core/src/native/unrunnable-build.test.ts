import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  llamaVariantBinaryPath,
  resolveLlamaFallbackBinary,
  resolveLlamaVariantBinary,
} from './llama-quarantine.js';
import { type EngineExit, formatExitCode, unrunnableBuildExit } from './unrunnable-build.js';

const ACCESS_VIOLATION = 3221225477; // 0xC0000005, as Node reports it on Windows
const beforeReady = (code: number | null, signal: string | null = null): EngineExit => ({
  code,
  signal,
  reachedReady: false,
});

describe('unrunnableBuildExit', () => {
  it('keeps SIGILL before readiness unrunnable on every platform and backend', () => {
    expect(unrunnableBuildExit(beforeReady(null, 'SIGILL'), 'cpu', 'linux')?.signal).toBe('SIGILL');
  });

  it("treats a Windows GPU build's crash status before readiness as unrunnable", () => {
    const result = unrunnableBuildExit(beforeReady(ACCESS_VIOLATION), 'vulkan', 'win32');
    expect(result?.signal).toBe('exit:0xc0000005');
    expect(result?.summary).toContain('Vulkan');
    expect(unrunnableBuildExit(beforeReady(0xc0000135), 'cuda', 'win32')?.signal).toBe(
      'exit:0xc0000135',
    );
  });

  it('never demotes the CPU build, which is the floor', () => {
    expect(unrunnableBuildExit(beforeReady(ACCESS_VIOLATION), 'cpu', 'win32')).toBeNull();
    expect(unrunnableBuildExit(beforeReady(ACCESS_VIOLATION), 'unknown', 'win32')).toBeNull();
  });

  it('leaves crashes attributable to the work, memory, or another cause alone', () => {
    const ready = { ...beforeReady(ACCESS_VIOLATION), reachedReady: true };
    expect(unrunnableBuildExit(ready, 'vulkan', 'win32')).toBeNull();
    const oom = { ...beforeReady(0xc0000409), panicKind: 'vulkan-out-of-memory' };
    expect(unrunnableBuildExit(oom, 'vulkan', 'win32')).toBeNull();
    // An ordinary exit code, or a status outside the list, is not a build fault.
    expect(unrunnableBuildExit(beforeReady(1), 'vulkan', 'win32')).toBeNull();
    expect(unrunnableBuildExit(beforeReady(0xc000013a), 'vulkan', 'win32')).toBeNull();
    // POSIX reports these as signals; only SIGILL qualifies there.
    expect(unrunnableBuildExit(beforeReady(null, 'SIGSEGV'), 'cuda', 'linux')).toBeNull();
    expect(unrunnableBuildExit(beforeReady(ACCESS_VIOLATION), 'cuda', 'linux')).toBeNull();
  });

  it('leaves a crash the engine explained to whatever owns that fault', () => {
    // abort() and an uncaught C++ exception exit 0xc0000409 exactly like a
    // driver fault does (measured on Windows); the printed assertion is the
    // only thing saying this one came from the model, not the build.
    const assertion = { ...beforeReady(0xc0000409), panicKind: 'assertion-failed' };
    expect(unrunnableBuildExit(assertion, 'vulkan', 'win32')).toBeNull();
    const cuda = { ...beforeReady(ACCESS_VIOLATION), panicKind: 'cuda-error' };
    expect(unrunnableBuildExit(cuda, 'cuda', 'win32')).toBeNull();
    // A CUDA fault that took SIGILL on the way down is a CUDA fault.
    const cudaThenSigill = { ...beforeReady(null, 'SIGILL'), panicKind: 'cuda-error' };
    expect(unrunnableBuildExit(cudaThenSigill, 'cuda', 'linux')).toBeNull();
  });

  it('still counts a crash the engine died without explaining', () => {
    // `illegal-instruction` is the supervisor's label for a silent SIGILL.
    const silentSigill = { ...beforeReady(null, 'SIGILL'), panicKind: 'illegal-instruction' };
    expect(unrunnableBuildExit(silentSigill, 'cuda', 'linux')?.signal).toBe('SIGILL');
    expect(unrunnableBuildExit(beforeReady(0xc0000135), 'vulkan', 'win32')?.signal).toBe(
      'exit:0xc0000135',
    );
  });

  it('formats NTSTATUS in hex and ordinary codes as numbers', () => {
    expect(formatExitCode(ACCESS_VIOLATION)).toBe('0xc0000005');
    expect(formatExitCode(-1073741819)).toBe('0xc0000005');
    expect(formatExitCode(3)).toBe('3');
  });
});

describe('resolveLlamaFallbackBinary', () => {
  const root = join('C:', 'Program Files', 'DocBlocks', 'resources', 'gezel-native');
  const build = (backend: string) => join(root, `win32-x64-${backend}`, 'gezel-llama-server.exe');
  const bundled = new Set([build('cuda'), build('vulkan'), build('cpu')]);
  const exists = (path: string) => bundled.has(path);

  it('steps down to the next bundled build beside the quarantined one', () => {
    const usable = () => true;
    expect(resolveLlamaFallbackBinary(build('vulkan'), 'vulkan', usable, exists)).toMatchObject({
      backend: 'cpu',
      path: build('cpu'),
    });
    expect(resolveLlamaFallbackBinary(build('cuda'), 'cuda', usable, exists)?.backend).toBe(
      'vulkan',
    );
  });

  it('skips a lower build that is itself quarantined', () => {
    const notVulkan = (backend: string) => backend !== 'vulkan';
    expect(resolveLlamaFallbackBinary(build('cuda'), 'cuda', notVulkan, exists)?.backend).toBe(
      'cpu',
    );
  });

  it('finds the preferred build again from the fallback it moved to', () => {
    const notCuda = (backend: string) => backend !== 'cuda';
    expect(resolveLlamaVariantBinary(build('cpu'), 'cpu', 'cuda', notCuda, exists)).toMatchObject({
      backend: 'vulkan',
      path: build('vulkan'),
    });
    expect(
      resolveLlamaVariantBinary(build('cpu'), 'cpu', 'cuda', () => true, exists)?.backend,
    ).toBe('cuda');
    expect(llamaVariantBinaryPath(build('cpu'), 'cpu', 'vulkan')).toBe(build('vulkan'));
    expect(
      llamaVariantBinaryPath(join(root, 'darwin-arm64', 'gezel-llama-server'), 'metal', 'cpu'),
    ).toBeNull();
  });

  it('finds nothing for a variant-less layout or an unbundled floor', () => {
    const single = join(root, 'darwin-arm64', 'gezel-llama-server');
    expect(
      resolveLlamaFallbackBinary(
        single,
        'metal',
        () => true,
        () => true,
      ),
    ).toBeNull();
    const onlyVulkan = (path: string) => path === build('vulkan');
    expect(
      resolveLlamaFallbackBinary(build('vulkan'), 'vulkan', () => true, onlyVulkan),
    ).toBeNull();
  });
});
