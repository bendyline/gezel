#!/usr/bin/env node
/**
 * Verify the Windows-on-ARM native payload without guessing which bytes in a
 * linked PE image are reachable instructions.
 *
 * `llvm-objdump -d` is not a safe ISA policy oracle for this job: it decodes
 * every word in executable sections, including literal pools, jump tables and
 * padding. On AArch64 those data words frequently decode as valid SVE/SME
 * instructions and produce false positives across unrelated Clang, MSVC and
 * Rust binaries.
 *
 * The reliable evidence available in CI is instead:
 *
 *   1. Every staged PE must declare IMAGE_FILE_MACHINE_ARM64.
 *   2. Locally compiled Clang engines must show the exact target and baseline
 *      in every compiler command, with no native/SVE/SME override.
 *   3. Their CMake cache must prove GGML_NATIVE=OFF and preserve the same
 *      baseline in both gezel's toolchain and ggml's CPU configuration.
 *
 * MSVC helpers are built with an explicit `/arch:armv8.0` in their build
 * scripts. The hash-pinned uv payload is compiled upstream, so the local gate
 * can prove its PE architecture but must not invent compiler provenance it
 * does not possess.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

export const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
export const DEFAULT_CLANG_BASELINE = 'armv8.2-a+dotprod+fp16';
export const DEFAULT_CLANG_TARGET = 'arm64-pc-windows-msvc';
export const DEFAULT_MSVC_BASELINE = 'armv8.0';

const SCANNABLE = new Set(['.exe', '.dll']);
const MODES = new Set(['clang-baseline', 'msvc-baseline', 'upstream-prebuilt']);

export function scannableFiles(dir, entries = readdirSync(dir)) {
  return entries
    .filter((name) => SCANNABLE.has(extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

export function readPeMachine(buffer, label = '<buffer>') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x40) {
    throw new Error(`${label} is too small to be a PE image`);
  }
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new Error(`${label} is missing the DOS MZ signature`);
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length) {
    throw new Error(`${label} has an out-of-range PE header offset`);
  }
  if (
    buffer[peOffset] !== 0x50 ||
    buffer[peOffset + 1] !== 0x45 ||
    buffer[peOffset + 2] !== 0 ||
    buffer[peOffset + 3] !== 0
  ) {
    throw new Error(`${label} is missing the PE signature`);
  }
  return buffer.readUInt16LE(peOffset + 4);
}

export function arm64PeFailures(files) {
  const failures = [];
  for (const file of files) {
    try {
      const machine = readPeMachine(readFileSync(file), file);
      if (machine !== IMAGE_FILE_MACHINE_ARM64) {
        failures.push(
          `${file} targets PE machine 0x${machine.toString(16).padStart(4, '0')}; expected ARM64 (0xaa64)`,
        );
      }
    } catch (error) {
      failures.push(error.message);
    }
  }
  return failures;
}

/** A small command-line tokenizer sufficient for CMake's JSON command field. */
export function splitCommandLine(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (const char of `${command ?? ''}`) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote) throw new Error('unterminated quote in compile command');
  if (current) tokens.push(current);
  return tokens;
}

function commandArguments(entry) {
  if (Array.isArray(entry?.arguments)) return entry.arguments.map(String);
  if (typeof entry?.command === 'string') return splitCommandLine(entry.command);
  return [];
}

function executableName(value) {
  return basename(win32.basename(`${value}`)).toLowerCase();
}

function flagValues(args, names) {
  const loweredNames = names.map((name) => name.toLowerCase());
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = `${args[index]}`;
    const lower = token.toLowerCase();
    for (const name of loweredNames) {
      if (lower === name) {
        values.push(`${args[index + 1] ?? ''}`);
      } else if (lower.startsWith(`${name}=`)) {
        values.push(token.slice(name.length + 1));
      }
    }
  }
  return values;
}

export function clangCompileCommandFailures(
  entries,
  { baseline = DEFAULT_CLANG_BASELINE, target = DEFAULT_CLANG_TARGET } = {},
) {
  if (!Array.isArray(entries)) return ['compile_commands.json must contain a JSON array'];

  const failures = [];
  let clangCommands = 0;
  for (const [index, entry] of entries.entries()) {
    let args;
    try {
      args = commandArguments(entry);
    } catch (error) {
      failures.push(`compile command ${index + 1}: ${error.message}`);
      continue;
    }
    const compilerIndex = args.findIndex((arg) =>
      /^clang(?:\+\+)?(?:\.exe)?$/i.test(executableName(arg)),
    );
    if (compilerIndex < 0) continue;
    clangCommands += 1;

    const flags = args.slice(compilerIndex + 1);
    const label = entry.file ? `${entry.file}` : `compile command ${index + 1}`;
    const targets = flagValues(flags, ['--target', '-target']);
    const marches = flagValues(flags, ['-march']);
    const mcpu = flagValues(flags, ['-mcpu']);
    const joined = flags.join(' ').toLowerCase();

    if (
      targets.length === 0 ||
      targets.some((value) => value.toLowerCase() !== target.toLowerCase())
    ) {
      failures.push(`${label}: expected every compiler target to be ${target}`);
    }
    if (
      marches.length === 0 ||
      marches.some((value) => value.toLowerCase() !== baseline.toLowerCase())
    ) {
      failures.push(`${label}: expected every -march value to be ${baseline}`);
    }
    if (mcpu.length > 0) {
      failures.push(`${label}: -mcpu is forbidden because it can override the declared baseline`);
    }
    if (/(?:^|\s)-mtune(?:=|\s+)native(?:\s|$)/i.test(joined)) {
      failures.push(`${label}: -mtune=native is forbidden on a redistributable build`);
    }
    if (/(?:\+|-)(?:sve|sve2|sme|sme2)(?:\b|_)/i.test(joined)) {
      failures.push(`${label}: explicitly enables or disables an SVE/SME feature`);
    }
  }

  if (clangCommands === 0) failures.push('compile_commands.json contains no clang compiler commands');
  return failures;
}

export function parseCmakeCache(contents) {
  const values = new Map();
  for (const line of `${contents}`.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const match = line.match(/^([^:=]+):[^=]+=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

export function cmakeCacheFailures(contents, { baseline = DEFAULT_CLANG_BASELINE } = {}) {
  const cache = parseCmakeCache(contents);
  const failures = [];
  const expected = new Map([
    ['GGML_NATIVE', 'OFF'],
    ['GGML_CPU_ARM_ARCH', baseline],
    ['GEZEL_ARM_ARCH', baseline],
    ['CMAKE_EXPORT_COMPILE_COMMANDS', 'ON'],
  ]);
  for (const [name, value] of expected) {
    if (!cache.has(name)) failures.push(`CMake cache is missing ${name}`);
    else if (cache.get(name).toLowerCase() !== value.toLowerCase()) {
      failures.push(`CMake cache has ${name}=${cache.get(name)}; expected ${value}`);
    }
  }
  return failures;
}

function parseArgs(argv) {
  const args = {
    dir: null,
    mode: null,
    compileCommands: null,
    cmakeCache: null,
    baseline: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dir') args.dir = argv[++index];
    else if (value === '--mode') args.mode = argv[++index];
    else if (value === '--compile-commands') args.compileCommands = argv[++index];
    else if (value === '--cmake-cache') args.cmakeCache = argv[++index];
    else if (value === '--baseline') args.baseline = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.dir || !args.mode || !MODES.has(args.mode)) {
    throw new Error(
      'usage: assert-arm64-baseline.mjs --dir <output> --mode <clang-baseline|msvc-baseline|upstream-prebuilt> [--compile-commands <file> --cmake-cache <file> --baseline <arch>]',
    );
  }
  if (args.mode === 'clang-baseline' && (!args.compileCommands || !args.cmakeCache)) {
    throw new Error('clang-baseline mode requires --compile-commands and --cmake-cache');
  }
  if (
    args.mode === 'msvc-baseline' &&
    (args.baseline ?? DEFAULT_MSVC_BASELINE).toLowerCase() !== DEFAULT_MSVC_BASELINE
  ) {
    throw new Error(`msvc-baseline mode requires --baseline ${DEFAULT_MSVC_BASELINE}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.dir);
  const files = scannableFiles(root)
    .map((name) => join(root, name))
    .filter((file) => statSync(file).isFile());
  if (files.length === 0) throw new Error(`no PE binaries found in ${root}`);

  const failures = arm64PeFailures(files);
  if (args.mode === 'clang-baseline') {
    const baseline = args.baseline ?? DEFAULT_CLANG_BASELINE;
    const commands = JSON.parse(readFileSync(resolve(args.compileCommands), 'utf8'));
    failures.push(...clangCompileCommandFailures(commands, { baseline }));
    failures.push(...cmakeCacheFailures(readFileSync(resolve(args.cmakeCache), 'utf8'), { baseline }));
  }

  if (failures.length > 0) {
    throw new Error(`Windows ARM64 contract failed:\n- ${failures.join('\n- ')}`);
  }

  process.stdout.write(`[arm64-baseline] ${files.length} staged PE file(s) target ARM64\n`);
  if (args.mode === 'clang-baseline') {
    process.stdout.write(
      `[arm64-baseline] clang commands and CMake cache pin ${args.baseline ?? DEFAULT_CLANG_BASELINE} without SVE/SME/native overrides\n`,
    );
  } else if (args.mode === 'msvc-baseline') {
    process.stdout.write(
      `[arm64-baseline] MSVC helper uses the build-script /arch:${args.baseline ?? DEFAULT_MSVC_BASELINE} contract\n`,
    );
  } else {
    process.stdout.write(
      '[arm64-baseline] upstream prebuilt provenance accepted after pinned-archive verification\n',
    );
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`[arm64-baseline] ${error.message}`);
    process.exitCode = 1;
  }
}
