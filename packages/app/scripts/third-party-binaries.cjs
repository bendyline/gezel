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
/**
 * Matched against a slash-normalized full path, case-insensitively. Each
 * exemption names both the vendor filename and the only payload subtree in
 * which that file is expected. A same-named binary elsewhere remains subject
 * to the first-party signature gate.
 *
 * Native releases are assembled under native/build and packaged under
 * native-bin, so those two roots deliberately share one scoped expression.
 */
const THIRD_PARTY_PATTERNS = [
  // NVIDIA CUDA redistributables. Distributable under the CUDA EULA's
  // Attachment A; they arrive from developer.download.nvidia.com with no
  // Authenticode signature at all (verified against NVIDIA's own sha256
  // manifest for 12.4.1).
  {
    pattern: '(?:^|/)(?:native-bin|native/build)/win32-x64(?:-[^/]+)?/cudart64_\\d+\\.dll$',
    source: 'NVIDIA CUDA Toolkit',
  },
  {
    pattern: '(?:^|/)(?:native-bin|native/build)/win32-x64(?:-[^/]+)?/cublas64_\\d+\\.dll$',
    source: 'NVIDIA CUDA Toolkit',
  },
  {
    pattern: '(?:^|/)(?:native-bin|native/build)/win32-x64(?:-[^/]+)?/cublasLt64_\\d+\\.dll$',
    source: 'NVIDIA CUDA Toolkit',
  },
  {
    pattern: '(?:^|/)(?:native-bin|native/build)/win32-x64(?:-[^/]+)?/nvrtc64_[^/]+\\.dll$',
    source: 'NVIDIA CUDA Toolkit',
  },
  {
    pattern:
      '(?:^|/)(?:native-bin|native/build)/win32-x64(?:-[^/]+)?/nvrtc-builtins64_[^/]+\\.dll$',
    source: 'NVIDIA CUDA Toolkit',
  },
  {
    pattern: '(?:^|/)(?:native-bin|native/build)/win32-x64(?:-[^/]+)?/nvJitLink_\\d+\\.dll$',
    source: 'NVIDIA CUDA Toolkit',
  },

  // Prebuilt vendor binaries we download rather than compile. uv.exe and
  // pnpm's optional fastlist helpers are unsigned as published; node.exe and
  // duckdb.exe carry their vendors' own signatures and must keep them —
  // duckdb.exe is Authenticode-signed by the DuckDB Foundation, so the
  // afterPack sweep must leave it byte-identical to their release.
  {
    pattern: '(?:^|/)(?:native-bin|native/build)/win32-x64(?:-[^/]+)?/uv\\.exe$',
    source: 'Astral uv (prebuilt release)',
  },
  {
    pattern: '(?:^|/)dist/duckdb-bundle/duckdb\\.exe$',
    source: 'DuckDB Foundation (prebuilt CLI release)',
  },
  {
    pattern: '(?:^|/)dist/node-bundle/node\\.exe$',
    source: 'OpenJS Node.js (prebuilt release)',
  },
  {
    pattern: '(?:^|/)node_modules/@vscode/ripgrep(?:-win32-x64)?/(?:[^/]+/)*rg\\.exe$',
    source: 'Microsoft vscode-ripgrep (prebuilt ripgrep)',
  },
  {
    pattern: '(?:^|/)dist/pnpm-bundle/(?:[^/]+/)*fastlist-[\\w.-]+\\.exe$',
    source: 'pnpm fastlist helper (ordinary pnpm package)',
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
  {
    pattern: '(?:^|/)node_modules/@resvg/resvg-js-win32-x64-msvc/resvgjs\\.win32-x64-msvc\\.node$',
    source: '@resvg/resvg-js (prebuilt napi-rs addon)',
  },
  {
    pattern: '(?:^|/)node_modules/@napi-rs/keyring-win32-x64-msvc/keyring\\.win32-x64-msvc\\.node$',
    source: '@napi-rs/keyring (prebuilt napi-rs addon)',
  },
  {
    pattern: '(?:^|/)node_modules/sqlite-vec-windows-x64/vec0\\.dll$',
    source: 'sqlite-vec (prebuilt extension)',
  },
  {
    pattern: '(?:^|/)node_modules/node-pty/(?:[^/]+/)*pty\\.node$',
    source: 'node-pty (prebuilt addon)',
  },
  {
    pattern: '(?:^|/)node_modules/node-pty/(?:[^/]+/)*conpty\\.node$',
    source: 'node-pty (prebuilt addon)',
  },
  {
    pattern: '(?:^|/)node_modules/node-pty/(?:[^/]+/)*conpty_console_list\\.node$',
    source: 'node-pty (prebuilt addon)',
  },
  {
    pattern: '(?:^|/)node_modules/node-pty/(?:[^/]+/)*winpty\\.dll$',
    source: 'node-pty (prebuilt winpty backend)',
  },
  {
    pattern: '(?:^|/)node_modules/node-pty/(?:[^/]+/)*winpty-agent\\.exe$',
    source: 'node-pty (prebuilt winpty backend)',
  },
];

/** Every Windows executable/loadable format the payload policy must visit. */
const WINDOWS_LOADABLE_EXTENSIONS = ['.exe', '.dll', '.node'];

const COMPILED = THIRD_PARTY_PATTERNS.map((entry) => ({
  ...entry,
  regex: new RegExp(entry.pattern, 'i'),
}));

function normalizedPath(filePath) {
  return String(filePath).replaceAll('\\', '/');
}

/** True when `filePath` is a vendor binary in its reviewed payload subtree. */
function isThirdPartyBinary(filePath) {
  const candidate = normalizedPath(filePath);
  return COMPILED.some((entry) => entry.regex.test(candidate));
}

/** The vendor a path belongs to, or null. Used for build-log attribution. */
function thirdPartySource(filePath) {
  const candidate = normalizedPath(filePath);
  return COMPILED.find((entry) => entry.regex.test(candidate))?.source ?? null;
}

/** Full reviewed policy record for a vendor path, or null. */
function thirdPartyMetadata(filePath) {
  const candidate = normalizedPath(filePath);
  const entry = COMPILED.find((item) => item.regex.test(candidate));
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
