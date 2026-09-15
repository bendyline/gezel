/**
 * The win32-arm64 ISA gate has to be right on synthetic input, because the
 * only other way to exercise it is a Snapdragon laptop. Both directions
 * matter equally: a false negative ships a binary that SIGILLs on every
 * target machine, and a false positive blocks the platform over NEON code
 * that was always fine.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { findForbiddenIsa, instructionText, scannableFiles } from './assert-arm64-baseline.mjs';

/** `llvm-objdump -d --no-show-raw-insn` output, as it really looks. */
const NEON_ONLY = `
gezel-llama-server.exe:\tfile format coff-arm64

Disassembly of section .text:

0000000140001000 <.text>:
140001000: stp\tx29, x30, [sp, #-32]!
140001004: mov\tx29, sp
140001008: ld1\t{ v0.16b, v1.16b }, [x0]
14000100c: fmla\tv2.4s, v0.4s, v1.4s
140001010: sdot\tv3.4s, v0.16b, v1.16b
140001014: smmla\tv4.4s, v0.16b, v1.16b
140001018: fcvtn\tv5.4h, v6.4s
14000101c: ldp\tx29, x30, [sp], #32
140001020: ret
`;

test('a NEON + dotprod + i8mm listing is within the baseline', () => {
  assert.deepEqual(findForbiddenIsa(NEON_ONLY), []);
});

test('SVE vector registers are rejected', () => {
  const findings = findForbiddenIsa('140001008: fmla\tz2.s, p0/m, z0.s, z1.s');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].feature, 'SVE');
});

test('SVE predicate qualifiers are rejected on their own', () => {
  // `p0/m` without a `z` operand still means the encoding is SVE.
  assert.equal(findForbiddenIsa('140001008: ld1b\t{ w0 }, p3/z, [x1]')[0]?.feature, 'SVE');
});

test('SVE-only mnemonics are rejected even with no register syntax', () => {
  for (const line of [
    '140001000: ptrue\tp0.b',
    '140001004: whilelo\tp1.s, x0, x1',
    '140001008: rdvl\tx0, #1',
    '14000100c: cntb\tx2',
  ]) {
    assert.equal(findForbiddenIsa(line).length, 1, `expected a finding for: ${line}`);
  }
});

test('SME instructions are rejected and labelled separately', () => {
  assert.equal(findForbiddenIsa('140001000: smstart\tza')[0]?.feature, 'SME');
  assert.equal(findForbiddenIsa('140001004: zero\t{ za }')[0]?.feature, 'SME');
  assert.equal(findForbiddenIsa('140001008: mova\tza0.s[w12, 0], p0/m, z1.s')[0]?.feature, 'SVE');
});

test('symbol names and section headers are never scanned', () => {
  // The words that trip the mnemonic patterns appear here in NON-instruction
  // positions. This is the false-positive case that made --no-show-raw-insn
  // and the address-anchored parse non-negotiable.
  const noise = `
gezel-llama-server.exe:\tfile format coff-arm64
Disassembly of section .ptrue_lookalike:
0000000140002000 <_ZN4ggml6whilelo17cntb_helper_ptrueEv>:
`;
  assert.deepEqual(findForbiddenIsa(noise), []);
});

test('instructionText isolates the instruction half', () => {
  assert.equal(instructionText('140001008: ld1\t{ v0.16b }, [x0]'), 'ld1\t{ v0.16b }, [x0]');
  assert.equal(instructionText('Disassembly of section .text:'), null);
  assert.equal(instructionText('0000000140001000 <.text>:'), null);
  assert.equal(instructionText(''), null);
});

test('identical offending instructions are reported once', () => {
  const repeated = [
    '140001000: ptrue\tp0.b',
    '140001004: ptrue\tp0.b',
    '140001008: ptrue\tp0.b',
  ].join('\n');
  assert.equal(findForbiddenIsa(repeated).length, 1);
});

test('only linkable artifacts are scanned', () => {
  // The sidecar JSON, the licence tree and stray text must not reach objdump:
  // it refuses non-object input, and this gate turns a refusal into a build
  // failure. THIRD_PARTY_LICENSES is the one that actually ships.
  const entries = [
    'gezel-llama-server.exe',
    'ggml-cpu.dll',
    'gezel-llama-build.json',
    'THIRD_PARTY_LICENSES',
    'notes.txt',
  ];
  assert.deepEqual(scannableFiles('.', entries), ['gezel-llama-server.exe', 'ggml-cpu.dll']);
});
