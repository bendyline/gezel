/**
 * Which files in the Windows payload are third-party binaries we
 * redistribute verbatim, rather than code we compiled.
 *
 * Policy: we Authenticode-sign only what we build. A signature is an
 * assertion of authorship and integrity; putting Bendyline's name on
 * NVIDIA's cuBLAS or Astral's uv claims something we are not in a
 * position to claim, and it rewrites bytes a vendor published under
 * their own redistribution terms. Files listed here ship exactly as
 * their vendor released them — byte-identical, hash-comparable against
 * the vendor's own manifest.
 *
 * Two consumers, one list:
 *   - scripts/after-pack.cjs        skips these in the signing sweep
 *   - release-electron.yml          exempts these in "Verify Windows
 *                                   signatures", which otherwise requires
 *                                   every exe/dll in the payload to be Valid
 *
 * Keep it an explicit allowlist, never a blanket "skip unsigned". The
 * point of the release gate is that a first-party DLL which silently
 * failed to get signed still fails the build.
 *
 * WINDOWS ONLY. macOS deliberately signs every Mach-O in the bundle,
 * including third-party ones — Apple's notary service rejects any
 * executable that is not Developer ID signed, and the vendors ship
 * weaker signatures than that (uv for macOS is `adhoc, linker-signed`
 * with no team identifier). There, re-signing is the price of
 * notarization, not a choice. See the macOS note in build-native.yml.
 */

/**
 * Matched against the file's basename, case-insensitively. Anchored so a
 * first-party binary cannot be exempted by having a vendor name inside it.
 */
const THIRD_PARTY_PATTERNS = [
  // NVIDIA CUDA redistributables. Distributable under the CUDA EULA's
  // Attachment A; they arrive from developer.download.nvidia.com with no
  // Authenticode signature at all (verified against NVIDIA's own sha256
  // manifest for 12.4.1).
  { pattern: '^cudart64_\\d+\\.dll$', source: 'NVIDIA CUDA Toolkit' },
  { pattern: '^cublas64_\\d+\\.dll$', source: 'NVIDIA CUDA Toolkit' },
  { pattern: '^cublasLt64_\\d+\\.dll$', source: 'NVIDIA CUDA Toolkit' },
  { pattern: '^nvrtc64_.+\\.dll$', source: 'NVIDIA CUDA Toolkit' },
  { pattern: '^nvrtc-builtins64_.+\\.dll$', source: 'NVIDIA CUDA Toolkit' },
  { pattern: '^nvJitLink_\\d+\\.dll$', source: 'NVIDIA CUDA Toolkit' },

  // Prebuilt vendor binaries we download rather than compile. uv.exe is
  // unsigned as Astral publishes it; node.exe carries OpenJS's own
  // signature and must keep it.
  { pattern: '^uv\\.exe$', source: 'Astral uv (prebuilt release)' },
  { pattern: '^node\\.exe$', source: 'OpenJS Node.js (prebuilt release)' },
  { pattern: '^pnpm\\.exe$', source: 'pnpm (prebuilt release)' },
];

const COMPILED = THIRD_PARTY_PATTERNS.map((entry) => ({
  ...entry,
  regex: new RegExp(entry.pattern, 'i'),
}));

/** True when `filePath`'s basename is a vendor binary we ship verbatim. */
function isThirdPartyBinary(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() ?? '';
  return COMPILED.some((entry) => entry.regex.test(base));
}

/** The vendor a path belongs to, or null. Used for build-log attribution. */
function thirdPartySource(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() ?? '';
  return COMPILED.find((entry) => entry.regex.test(base))?.source ?? null;
}

module.exports = { THIRD_PARTY_PATTERNS, isThirdPartyBinary, thirdPartySource };

// `node third-party-binaries.cjs --patterns` emits the raw pattern list as
// JSON so the release workflow's PowerShell verification step reads the same
// source of truth instead of re-declaring it in YAML. The expressions use
// only constructs .NET's regex engine shares with JavaScript's.
if (require.main === module && process.argv.includes('--patterns')) {
  console.log(JSON.stringify(THIRD_PARTY_PATTERNS.map((entry) => entry.pattern)));
}
