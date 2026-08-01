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
 * Four consumers, one policy:
 *   - scripts/after-pack.cjs        skips these in the signing sweep
 *   - release-electron.yml          exempts these in "Verify Windows
 *                                   signatures", which otherwise requires
 *                                   every exe/dll in the payload to be Valid
 *   - scripts/verify-pe-tree.mjs    exempts these when auditing the gezeld
 *                                   service bundle before it is sealed into
 *                                   service-bundle.tar.gz, which neither of
 *                                   the above can see inside
 *   - the same consumers also read WINDOWS_LOADABLE_EXTENSIONS so `.node`
 *                                   addons cannot fall outside the sweep
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
const PNPM_RUNTIME_INVENTORY = require('../src/pnpm-runtime-inventory.json');
const REFLINK_WINDOWS_X64 = PNPM_RUNTIME_INVENTORY.packages.find(
  (pkg) => pkg.name === '@reflink/reflink-win32-x64-msvc',
);
if (!REFLINK_WINDOWS_X64) {
  throw new Error('pnpm runtime inventory has no @reflink/reflink-win32-x64-msvc identity');
}

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

  // Prebuilt vendor binaries we download rather than compile. uv.exe and
  // pnpm's optional fastlist helpers are unsigned as published; node.exe
  // carries OpenJS's own signature and must keep it.
  { pattern: '^uv\\.exe$', source: 'Astral uv (prebuilt release)' },
  { pattern: '^node\\.exe$', source: 'OpenJS Node.js (prebuilt release)' },
  {
    pattern: '^fastlist-[\\w.-]+\\.exe$',
    source: 'pnpm fastlist helper (ordinary pnpm package)',
  },
  {
    pattern: '^reflink\\.win32-x64-msvc\\.node$',
    source: `${REFLINK_WINDOWS_X64.name}@${REFLINK_WINDOWS_X64.version} (pnpm vendored prebuilt addon)`,
    package: REFLINK_WINDOWS_X64.name,
    version: REFLINK_WINDOWS_X64.version,
    license: REFLINK_WINDOWS_X64.license,
    packageSha256: PNPM_RUNTIME_INVENTORY.packageSha256,
  },

  // Prebuilt native addons inside the gezeld service bundle. npm ships these
  // as compiled artifacts; we never build them, so the same authorship rule
  // that exempts cuBLAS exempts them. Listed explicitly because
  // verify-pe-tree.mjs now inspects the bundle tree before it is archived —
  // before that, they were exempt only because nothing looked inside the
  // tarball. Their peers from the same packages (onnxruntime's DLLs,
  // node-pty's ConPTY helpers) arrive Microsoft-signed and are preserved by
  // the isValidlySigned check rather than by this list.
  //
  // Basename matching is safe here: Gezel compiles no .node addons at all, so
  // there is no first-party binary these names could shadow.
  {
    pattern: '^resvgjs\\.win32-x64-msvc\\.node$',
    source: '@resvg/resvg-js (prebuilt napi-rs addon)',
  },
  {
    pattern: '^keyring\\.win32-x64-msvc\\.node$',
    source: '@napi-rs/keyring (prebuilt napi-rs addon)',
  },
  { pattern: '^vec0\\.dll$', source: 'sqlite-vec (prebuilt extension)' },
  { pattern: '^pty\\.node$', source: 'node-pty (prebuilt addon)' },
  { pattern: '^conpty\\.node$', source: 'node-pty (prebuilt addon)' },
  { pattern: '^conpty_console_list\\.node$', source: 'node-pty (prebuilt addon)' },
  { pattern: '^winpty\\.dll$', source: 'node-pty (prebuilt winpty backend)' },
  { pattern: '^winpty-agent\\.exe$', source: 'node-pty (prebuilt winpty backend)' },
];

/** Every Windows executable/loadable format the payload policy must visit. */
const WINDOWS_LOADABLE_EXTENSIONS = ['.exe', '.dll', '.node'];

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

/** Full reviewed policy record for a vendor path, or null. */
function thirdPartyMetadata(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() ?? '';
  const entry = COMPILED.find((candidate) => candidate.regex.test(base));
  if (!entry) return null;
  const { regex: _regex, ...metadata } = entry;
  return metadata;
}

function isWindowsLoadableBinary(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const extension = dot >= 0 ? base.slice(dot).toLowerCase() : '';
  return WINDOWS_LOADABLE_EXTENSIONS.includes(extension);
}

module.exports = {
  THIRD_PARTY_PATTERNS,
  WINDOWS_LOADABLE_EXTENSIONS,
  isThirdPartyBinary,
  isWindowsLoadableBinary,
  thirdPartyMetadata,
  thirdPartySource,
};

// `node third-party-binaries.cjs --patterns` emits the raw pattern list as
// JSON so the release workflow's PowerShell verification step reads the same
// source of truth instead of re-declaring it in YAML. The expressions use
// only constructs .NET's regex engine shares with JavaScript's.
if (require.main === module && process.argv.includes('--patterns')) {
  console.log(JSON.stringify(THIRD_PARTY_PATTERNS.map((entry) => entry.pattern)));
}
if (require.main === module && process.argv.includes('--extensions')) {
  console.log(JSON.stringify(WINDOWS_LOADABLE_EXTENSIONS));
}
