import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CLANG_BASELINE,
  IMAGE_FILE_MACHINE_ARM64,
  arm64PeFailures,
  clangCompileCommandFailures,
  cmakeCacheFailures,
  readPeMachine,
  scannableFiles,
  splitCommandLine,
} from './assert-arm64-baseline.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function peFixture(machine = IMAGE_FILE_MACHINE_ARM64) {
  const buffer = Buffer.alloc(0x100);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write('PE\0\0', 0x80, 'binary');
  buffer.writeUInt16LE(machine, 0x84);
  return buffer;
}

function clangEntry(
  file = 'kernel.cpp',
  flags = `--target=arm64-pc-windows-msvc -march=${DEFAULT_CLANG_BASELINE}`,
) {
  return {
    directory: 'C:/a/gezel',
    command: `"C:/Program Files/LLVM/bin/clang++.exe" ${flags} -c ${file}`,
    file,
  };
}

function cacheFixture(overrides = {}) {
  return Object.entries({
    GGML_NATIVE: 'OFF',
    GGML_CPU_ARM_ARCH: DEFAULT_CLANG_BASELINE,
    GEZEL_ARM_ARCH: DEFAULT_CLANG_BASELINE,
    CMAKE_EXPORT_COMPILE_COMMANDS: 'ON',
    ...overrides,
  })
    .map(([name, value]) => `${name}:STRING=${value}`)
    .join('\n');
}

test('reads IMAGE_FILE_MACHINE_ARM64 from a PE header', () => {
  assert.equal(readPeMachine(peFixture()), IMAGE_FILE_MACHINE_ARM64);
  assert.equal(readPeMachine(peFixture(0x8664)), 0x8664);
});

test('rejects malformed PE payloads', () => {
  assert.throws(() => readPeMachine(Buffer.alloc(8)), /too small/);
  assert.throws(() => readPeMachine(Buffer.alloc(0x100)), /MZ signature/);
});

test('reports a linked PE with the wrong machine type', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-arm64-pe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'wrong.exe');
  writeFileSync(file, peFixture(0x8664));
  assert.match(arm64PeFailures([file]).join('\n'), /expected ARM64/);
});

test('only linked Windows payloads are selected for PE validation', () => {
  assert.deepEqual(
    scannableFiles('.', [
      'gezel-llama-server.exe',
      'ggml-cpu.dll',
      'gezel-llama-build.json',
      'THIRD_PARTY_LICENSES',
      'notes.txt',
    ]),
    ['gezel-llama-server.exe', 'ggml-cpu.dll'],
  );
});

test('tokenizes quoted CMake compiler paths without splitting Program Files', () => {
  assert.deepEqual(
    splitCommandLine(
      '"C:/Program Files/LLVM/bin/clang++.exe" --target=arm64-pc-windows-msvc -c source.cpp',
    ),
    [
      'C:/Program Files/LLVM/bin/clang++.exe',
      '--target=arm64-pc-windows-msvc',
      '-c',
      'source.cpp',
    ],
  );
});

test('accepts every clang command pinned to the conservative WoA baseline', () => {
  const entries = [
    clangEntry('one.c'),
    {
      directory: 'C:/a/gezel',
      arguments: [
        'C:/Program Files/LLVM/bin/clang.exe',
        '--target',
        'arm64-pc-windows-msvc',
        '-march',
        DEFAULT_CLANG_BASELINE,
        '-c',
        'two.c',
      ],
      file: 'two.c',
    },
    { command: 'rc.exe /fo resource.res resource.rc', file: 'resource.rc' },
  ];
  assert.deepEqual(clangCompileCommandFailures(entries), []);
});

test('rejects missing, host-native, and SVE/SME compiler overrides', () => {
  assert.match(
    clangCompileCommandFailures([clangEntry('bad.c', '-march=native')]).join('\n'),
    /target|march/,
  );
  assert.match(
    clangCompileCommandFailures([
      clangEntry(
        'bad.cpp',
        `--target=arm64-pc-windows-msvc -march=${DEFAULT_CLANG_BASELINE} -mcpu=native`,
      ),
    ]).join('\n'),
    /-mcpu is forbidden/,
  );
  assert.match(
    clangCompileCommandFailures([
      clangEntry(
        'bad.cpp',
        `--target=arm64-pc-windows-msvc -march=${DEFAULT_CLANG_BASELINE}+sve2`,
      ),
    ]).join('\n'),
    /march|SVE\/SME/,
  );
  assert.match(clangCompileCommandFailures([]).join('\n'), /no clang compiler commands/);
});

test('requires CMake and ggml to agree on the same non-native baseline', () => {
  assert.deepEqual(cmakeCacheFailures(cacheFixture()), []);
  assert.match(cmakeCacheFailures(cacheFixture({ GGML_NATIVE: 'ON' })).join('\n'), /expected OFF/);
  assert.match(
    cmakeCacheFailures(cacheFixture({ GGML_CPU_ARM_ARCH: 'armv9-a+sve2' })).join('\n'),
    /GGML_CPU_ARM_ARCH/,
  );
  assert.match(
    cmakeCacheFailures('GGML_NATIVE:BOOL=OFF').join('\n'),
    /missing GGML_CPU_ARM_ARCH/,
  );
});

test('CLI validates PE, compile database, and CMake cache together', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-arm64-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const commands = join(dir, 'compile_commands.json');
  const cache = join(dir, 'CMakeCache.txt');
  writeFileSync(join(dir, 'engine.exe'), peFixture());
  writeFileSync(commands, JSON.stringify([clangEntry()]));
  writeFileSync(cache, cacheFixture());

  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts/assert-arm64-baseline.mjs'),
      '--dir',
      dir,
      '--mode',
      'clang-baseline',
      '--compile-commands',
      commands,
      '--cmake-cache',
      cache,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /clang commands and CMake cache pin/);
});

test('MSVC CLI mode fails closed on any looser claimed baseline', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-arm64-msvc-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'helper.exe'), peFixture());

  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts/assert-arm64-baseline.mjs'),
      '--dir',
      dir,
      '--mode',
      'msvc-baseline',
      '--baseline',
      'armv8.5',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --baseline armv8\.0/);
});

test('Windows ARM64 build scripts keep their architecture evidence explicit', () => {
  const sdBuild = readFileSync(resolve(repoRoot, 'native/engines/sd-cpp/build.ps1'), 'utf8');
  assert.match(sdBuild, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.ARM64/);
  assert.match(sdBuild, /vcvarsarm64\.bat/);
  assert.match(sdBuild, /vcvarsamd64_arm64\.bat/);
  assert.match(sdBuild, /-DGEZEL_ARM_ARCH=\$armArch/);

  for (const relativePath of [
    'native/helpers/device-health/build.ps1',
    'native/helpers/service-host/build.ps1',
  ]) {
    assert.match(
      readFileSync(resolve(repoRoot, relativePath), 'utf8'),
      /-DCMAKE_CXX_FLAGS=\/arch:armv8\.0/,
    );
  }

  const toolchain = readFileSync(
    resolve(repoRoot, 'native/cmake/arm64-windows-llvm.cmake'),
    'utf8',
  );
  assert.match(toolchain, /CMAKE_EXPORT_COMPILE_COMMANDS ON/);
  assert.match(toolchain, /CMAKE_ASM_FLAGS_INIT/);

  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/build-native.yml'), 'utf8');
  assert.doesNotMatch(workflow, /llvm-objdump/);
  assert.match(workflow, /--compile-commands/);
  assert.match(workflow, /--mode clang-baseline/);
});
