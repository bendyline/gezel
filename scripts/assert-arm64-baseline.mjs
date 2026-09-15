#!/usr/bin/env node
/**
 * Fail a Windows-on-ARM native build that emitted instructions the target
 * CPUs cannot execute.
 *
 * This exists because CI cannot catch the bug it guards. GitHub's
 * `windows-11-arm` runners are Cobalt / Neoverse-class parts that implement
 * **SVE and SVE2**; the laptops gezel actually ships to — Snapdragon X Elite
 * (Oryon) and every other shipping Windows-on-ARM part — do not. Anything
 * that tunes to the build host (`GGML_NATIVE=ON`, a `-mcpu=native`
 * equivalent, or a dependency compiled that way) produces a binary that
 * passes the `--help` smoke test on the runner and dies with an illegal
 * instruction on a user's machine. The build host can, by definition,
 * execute everything it just produced, so no runtime probe finds this.
 *
 * It is the same defect class as the native-v0.1.29 AVX-512 regression on
 * x64, which is why `win32-x64` answers it with `GGML_CPU_ALL_VARIANTS`
 * runtime dispatch instead. That option is unavailable here: ggml's ARM
 * variant table covers Linux, Android and Apple and raises
 * `FATAL_ERROR "Unsupported ARM target OS: Windows"` otherwise, so the
 * win32-arm64 leg pins one conservative baseline and proves it here.
 *
 * SVE and SME are the whole gate. Dotprod, i8mm and fp16 arithmetic are in
 * the baseline deliberately — every shipping WoA part has them.
 *
 *   node scripts/assert-arm64-baseline.mjs --dir native/build/win32-arm64-cpu
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Extensions worth disassembling. Everything else staged beside the engine is
 * data: the build-info sidecar, the THIRD_PARTY_LICENSES tree, SHA files.
 *
 * Extensionless entries are deliberately NOT scanned. This gate only runs on
 * `win32-arm64*`, where every linkable artifact carries `.exe` or `.dll`, and
 * admitting them would hand objdump a licence text file and turn its refusal
 * into a build failure. Reusing this gate on a Unix arm64 key means adding
 * `''` back and teaching `disassemble` to tell "not an object file" apart
 * from a real objdump fault.
 */
const SCANNABLE = new Set(['.exe', '.dll']);

/**
 * Instruction-text patterns that prove a forbidden extension was emitted.
 *
 * Matched against the *instruction* half of each disassembly line only --
 * `--no-show-raw-insn` keeps the encoded bytes out of the haystack, so a
 * symbol name or an opcode byte can never trip these.
 */
export const FORBIDDEN_ISA = Object.freeze([
  {
    feature: 'SVE',
    // `z3.s` is an SVE vector register with an element-size suffix. NEON
    // spells the same idea `v3.4s`, so the leading `z` discriminates.
    pattern: /\bz\d{1,2}\.[bhsdq]\b/,
  },
  {
    feature: 'SVE',
    // `p0/m`, `p2/z` are governing-predicate qualifiers, SVE-only syntax.
    pattern: /\bp\d{1,2}\/[mz]\b/,
  },
  {
    feature: 'SVE',
    pattern:
      /\b(?:ptrue|pfalse|whilelo|whilelt|whilels|whilele|rdvl|addvl|addpl|cntb|cnth|cntw|cntd|setffr|rdffr|wrffr)\b/,
  },
  {
    feature: 'SME',
    pattern: /\b(?:smstart|smstop|rdsvl|addsvl|addspl)\b/,
  },
  {
    feature: 'SME',
    // `za0.s`, and the `zero {za}` form.
    pattern: /\bza\d?\.[bhsdq]\b|\bzero\s+\{\s*za\b/,
  },
]);

/**
 * The instruction half of one `llvm-objdump -d --no-show-raw-insn` line, or
 * null for anything that is not an instruction (headers, symbol lines,
 * section banners, blank lines).
 */
export function instructionText(line) {
  const match = line.match(/^\s*[0-9a-f]+:\s+(\S.*)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Every forbidden-ISA hit in a disassembly listing.
 *
 * Returns `{ feature, instruction }` objects rather than throwing so the
 * caller can report all offenders in one pass -- a build that emitted SVE in
 * three files should say so once, not fail three times in a row.
 */
export function findForbiddenIsa(disassembly) {
  const findings = [];
  const seen = new Set();
  for (const line of disassembly.split('\n')) {
    const instruction = instructionText(line);
    if (!instruction) continue;
    for (const { feature, pattern } of FORBIDDEN_ISA) {
      if (!pattern.test(instruction)) continue;
      const key = `${feature} ${instruction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ feature, instruction });
      break;
    }
  }
  return findings;
}

/** Files in `dir` worth disassembling, sorted for stable output. */
export function scannableFiles(dir, entries = readdirSync(dir)) {
  return entries
    .filter((name) => SCANNABLE.has(extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

function disassemble(objdump, file) {
  const result = spawnSync(objdump, ['-d', '--no-show-raw-insn', file], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}`.trim();
    throw new Error(`${objdump} failed on ${file}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout ?? '';
}

function parseArgs(argv) {
  const args = { dir: null, objdump: 'llvm-objdump' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--objdump') args.objdump = argv[++i];
  }
  if (!args.dir) throw new Error('usage: assert-arm64-baseline.mjs --dir <native/build/...>');
  return args;
}

function main() {
  const { dir, objdump } = parseArgs(process.argv.slice(2));
  const root = resolve(dir);
  const files = scannableFiles(root).filter((name) => statSync(join(root, name)).isFile());
  if (files.length === 0) {
    // Fail closed. An empty scan means the build staged nothing, or the
    // output directory moved -- either way the gate proved nothing, and
    // "proved nothing" must never read as "passed".
    throw new Error(`no scannable binaries in ${root}`);
  }

  let bad = 0;
  for (const name of files) {
    const findings = findForbiddenIsa(disassemble(objdump, join(root, name)));
    if (findings.length === 0) {
      process.stdout.write(`[arm64-baseline] ${name}: clean\n`);
      continue;
    }
    bad += 1;
    const features = [...new Set(findings.map((f) => f.feature))].join(', ');
    const why = [
      'Snapdragon X (Oryon) has neither, so this binary SIGILLs on the hardware it ships to.',
      'The build host has SVE2 and cannot reproduce it.',
      'Check that GGML_NATIVE stays OFF and GGML_CPU_ARM_ARCH names a baseline without SVE.',
    ].join(' ');
    process.stdout.write(`::error::${name} contains ${features} instructions. ${why}\n`);
    for (const finding of findings.slice(0, 10)) {
      process.stdout.write(`    ${finding.feature}: ${finding.instruction}\n`);
    }
    if (findings.length > 10) {
      process.stdout.write(`    ... and ${findings.length - 10} more\n`);
    }
  }

  if (bad > 0) throw new Error(`${bad} binary/binaries emit instructions outside the WoA baseline`);
  process.stdout.write(`[arm64-baseline] ${files.length} binaries within the WoA baseline\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`[arm64-baseline] ${error.message}`);
    process.exitCode = 1;
  }
}
