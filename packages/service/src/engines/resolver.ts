import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, nowIso } from '@bendyline/gezel';
import { type NativeBinaryName, resolvePlatformKey } from '@bendyline/gezel/native';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { type DownloadResult, downloadWithRetry } from '../utils/download-with-retry.js';
import {
  SHA256SUMS_DIGEST,
  effectiveEngineRelease,
  isPlaceholderDigest,
} from './native-manifest.js';
import {
  type SignaturePolicy,
  type SignatureResult,
  stripQuarantine,
  verifyCodeSignature,
} from './signature.js';

const log = createLogger('engine-resolver');

const REPO = 'bendyline/gezel';
const GITHUB_API = 'https://api.github.com';

/** Map each engine to the env var the providers read (mirrors discover.ts). */
const ENGINE_ENV_VAR: Record<NativeBinaryName, string> = {
  'llama-server': 'GEZEL_LLAMA_SERVER_BIN',
  'ds4-server': 'GEZEL_DS4_SERVER_BIN',
  'sd-server': 'GEZEL_SD_SERVER_BIN',
  'whisper-server': 'GEZEL_WHISPER_SERVER_BIN',
  'device-health': 'GEZEL_DEVICE_HEALTH_BIN',
  uv: 'GEZEL_UV_BIN',
};

/**
 * Thrown for the "can't resolve, and that's expected/actionable" cases:
 * no pinned release, no token while private, asset missing, verification
 * failed. Callers surface the message; they don't retry blindly.
 */
export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

export type EngineResolveEvent =
  | { type: 'progress'; bytesWritten: number; totalBytes: number }
  | { type: 'retrying'; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: 'verifying'; what: 'sha256' | 'signature' }
  | { type: 'done'; binPath: string; cached: boolean }
  | { type: 'error'; error: string };

export interface ResolveEngineOptions {
  engine: NativeBinaryName;
  home: string;
  /** GPU backend for llama-server (`cuda`/`vulkan`/`metal`/`cpu`); omit for single-variant engines. */
  variant?: string;
  /** Native release version; defaults to the source pin / `GEZEL_NATIVE_ENGINE_VERSION`. */
  version?: string;
  /** Signature enforcement; defaults to `prefer` (binaries aren't signed yet). */
  signaturePolicy?: SignaturePolicy;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  // ── test / dev seams ──
  /** Pre-resolved token: `undefined` = auto-resolve; `null` = explicitly none. */
  token?: string | null;
  /** Override the source-pinned SHA256SUMS digest (tests). */
  expectedSha256sumsDigest?: string;
  /** Override the GitHub API base (tests point this at a local fixture). */
  githubApiBase?: string;
  /** Override signature verification (tests — avoids spawning powershell/codesign). */
  verifyOverride?: typeof verifyCodeSignature;
}

export interface EngineResolveResult {
  binPath: string;
  cached: boolean;
  signature: SignatureResult;
  version: string;
  assetPlatformKey: string;
}

interface GhAsset {
  name: string;
  url: string;
  size?: number;
}
interface GhRelease {
  tag_name?: string;
  assets?: GhAsset[];
}

/**
 * Resolve an engine binary: return a cached one if present, else download
 * the right platform+variant archive from the pinned `native-v<version>`
 * release, verify (SHA256SUMS digest → archive sha → code signature),
 * extract atomically into `~/.gezel/engines/native-bin/<version>/<key>/`,
 * and stamp the provider env var.
 *
 * Yields `progress`/`retrying`/`verifying`/`done`/`error`; the generator's
 * RETURN value carries the resolved result. On a handled failure it yields
 * a terminal `error` then throws {@link EngineUnavailableError} on the next
 * pull (so registry consumers break on the event and direct drainers see
 * the throw — see `resolveEngineToCompletion`).
 */
export async function* resolveEngine(
  opts: ResolveEngineOptions,
): AsyncGenerator<EngineResolveEvent, EngineResolveResult, void> {
  const platformKey = resolvePlatformKey();
  if (!platformKey) {
    yield* fail(
      `unsupported platform ${process.platform}/${process.arch} — no native engine build exists`,
    );
  }
  const engine = opts.engine;
  const version = stripVer(opts.version ?? effectiveEngineRelease());
  // ds4-server on Linux lives in the `-cuda` archive, sharing one copy of the
  // NVIDIA redistributables with llama-server's CUDA build instead of shipping
  // them twice (see scripts/native-payload.mjs). It is the engine's only Linux
  // build, so this is a fact about where the archive is, not a backend choice
  // the caller makes — derive it here rather than making every call site pass
  // `variant: 'cuda'` and risk one forgetting. macOS ds4 is Metal and stays in
  // the bare key.
  const impliedVariant =
    engine === 'ds4-server' && process.platform === 'linux' ? 'cuda' : undefined;
  const variant = opts.variant ?? impliedVariant;
  const assetPlatformKey = variant ? `${platformKey}-${variant}` : (platformKey as string);
  const isWin = process.platform === 'win32';
  const ext = isWin ? 'zip' : 'tar.gz';
  const exeExt = isWin ? '.exe' : '';
  // Build scripts emit the server under a `gezel-` prefix (so the running
  // process reads as `gezel-llama-server` for attribution while keeping the
  // upstream lineage in the suffix). Prefer that name, but fall back to the
  // bare upstream name so releases cut BEFORE the rename still resolve. `uv`
  // is vendored unmodified and never prefixed. `engine` stays the logical id.
  // gezel- prefixed name is primary (`uv` is vendored unmodified, never prefixed).
  const primaryBinaryFile = engine === 'uv' ? `uv${exeExt}` : `gezel-${engine}${exeExt}`;
  const binaryFileCandidates =
    engine === 'uv' ? [primaryBinaryFile] : [primaryBinaryFile, `${engine}${exeExt}`];
  const policy = opts.signaturePolicy ?? 'prefer';

  const versionDir = join(opts.home, 'engines', 'native-bin', version);
  const cacheDir = join(versionDir, assetPlatformKey);
  const sentinelPath = join(cacheDir, '.verified.json');
  // Pick whichever candidate is actually on disk (gezel- preferred). binPath is
  // reassigned after extraction once we see what the downloaded archive holds.
  let binPath = join(cacheDir, primaryBinaryFile);
  for (const cand of binaryFileCandidates) {
    if (existsSync(join(cacheDir, cand))) {
      binPath = join(cacheDir, cand);
      break;
    }
  }

  // ── Fast path: already resolved + verified ──
  if (existsSync(binPath) && existsSync(sentinelPath)) {
    stampEnv(engine, binPath, variant, versionDir);
    yield { type: 'done', binPath, cached: true };
    return {
      binPath,
      cached: true,
      signature: await readSentinelSignature(sentinelPath),
      version,
      assetPlatformKey,
    };
  }

  // ── Availability gates ──
  const expectedDigest = (opts.expectedSha256sumsDigest ?? SHA256SUMS_DIGEST).toLowerCase();
  const unpinned = isPlaceholderDigest(expectedDigest);
  const hasOverride =
    opts.version !== undefined ||
    opts.expectedSha256sumsDigest !== undefined ||
    !!process.env.GEZEL_NATIVE_ENGINE_VERSION;
  if (unpinned && !hasOverride) {
    yield* fail(
      'on-device engine auto-download is not available in this build yet (no native release pinned). Point GEZEL_LLAMA_SERVER_BIN / the External engine URL at a llama-server, or use a build that bundles the engine.',
    );
  }

  const apiBase = opts.githubApiBase ?? GITHUB_API;
  const isLocalFixture = apiBase !== GITHUB_API;
  const token = opts.token !== undefined ? opts.token : await resolveGithubToken();
  if (!token && !isLocalFixture) {
    yield* fail(
      'engine download needs a GitHub token while the gezel repo is private — set GEZEL_GITHUB_TOKEN or run `gh auth login`. (No token needed once the repo is public.)',
    );
  }

  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const tag = `native-v${version}`;
  const archiveName = `gezel-native-${version}-${assetPlatformKey}.${ext}`;

  // ── 1. Resolve release + assets ──
  const release = await ghJson(`${apiBase}/repos/${REPO}/releases/tags/${tag}`, baseFetch, token);
  const archiveAsset = release.assets?.find((a) => a.name === archiveName);
  const sumsAsset = release.assets?.find((a) => a.name === 'SHA256SUMS');
  if (!archiveAsset) {
    yield* fail(
      `release ${tag} has no asset '${archiveName}' (this platform/variant isn't built for that release)`,
    );
  }
  if (!sumsAsset) {
    yield* fail(
      `release ${tag} is missing its SHA256SUMS manifest — refusing to install unverified`,
    );
  }

  // ── 2. SHA256SUMS: verify own digest against the source pin, then parse ──
  const sumsBytes = await ghBytes((sumsAsset as GhAsset).url, baseFetch, token);
  const sumsDigest = createHash('sha256').update(sumsBytes).digest('hex');
  if (!unpinned && sumsDigest !== expectedDigest) {
    yield* fail(
      `SHA256SUMS digest mismatch for ${tag}: this build pins ${expectedDigest.slice(0, 16)}… but the release served ${sumsDigest.slice(0, 16)}…. Refusing — the release may have been tampered with or re-cut.`,
    );
  }
  if (unpinned) {
    log.warn(
      `[engine-resolver] ${tag} resolved UNPINNED (no baked digest) — verifying the archive against the release's own SHA256SUMS only`,
    );
  }
  const sums = parseSums(sumsBytes.toString('utf8'));
  const expectedArchiveSha = sums.get(archiveName);
  if (!expectedArchiveSha) {
    yield* fail(
      `'${archiveName}' is not listed in ${tag}'s SHA256SUMS — refusing to install unverified`,
    );
  }

  // ── 3. Download the archive (auth headers injected into the fetch) ──
  await mkdir(versionDir, { recursive: true });
  const tmpExtractDir = `${cacheDir}.tmp`;
  await rm(tmpExtractDir, { recursive: true, force: true });
  const archivePath = join(versionDir, `${archiveName}.download`);
  const dl = downloadWithRetry({
    url: (archiveAsset as GhAsset).url,
    destPath: archivePath,
    approxSizeBytes: (archiveAsset as GhAsset).size ?? 0,
    fetchImpl: makeAuthedFetch(baseFetch, token),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  let outcome: DownloadResult | undefined;
  while (true) {
    const step = await dl.next();
    if (step.done) {
      outcome = step.value;
      break;
    }
    const ev = step.value;
    if (ev.type === 'progress') {
      yield { type: 'progress', bytesWritten: ev.bytesWritten, totalBytes: ev.totalBytes };
    } else {
      yield {
        type: 'retrying',
        attempt: ev.attempt,
        maxAttempts: ev.maxAttempts,
        delayMs: ev.delayMs,
        reason: ev.reason,
      };
    }
  }
  const partialPath = `${archivePath}.partial`;
  if (!outcome || outcome.kind === 'aborted') {
    yield* fail('engine download was cancelled');
  }
  if (outcome && outcome.kind === 'error') {
    yield* fail(outcome.error);
  }

  // ── 4. Verify archive sha256 against SHA256SUMS ──
  yield { type: 'verifying', what: 'sha256' };
  const actualSha = (await sha256File(partialPath)).toLowerCase();
  if (actualSha !== (expectedArchiveSha as string).toLowerCase()) {
    await rm(partialPath, { force: true });
    yield* fail(
      `${archiveName} failed integrity check: expected ${(expectedArchiveSha as string).slice(0, 16)}…, got ${actualSha.slice(0, 16)}…`,
    );
  }

  // ── 5. Extract into a temp dir ──
  await mkdir(tmpExtractDir, { recursive: true });
  try {
    if (ext === 'zip') {
      new AdmZip(partialPath).extractAllTo(tmpExtractDir, /* overwrite */ true);
    } else {
      await tar.extract({ file: partialPath, cwd: tmpExtractDir });
    }
  } finally {
    await rm(partialPath, { force: true });
  }
  // Find the binary inside the extracted archive — gezel- prefixed name
  // (current releases) preferred, bare upstream name for pre-rename releases.
  // Reassign binPath so the publish + env stamp below use the real name.
  let tmpBin = '';
  for (const cand of binaryFileCandidates) {
    const p = join(tmpExtractDir, cand);
    if (existsSync(p)) {
      tmpBin = p;
      binPath = join(cacheDir, cand);
      break;
    }
  }
  if (!tmpBin) {
    await rm(tmpExtractDir, { recursive: true, force: true });
    yield* fail(
      `extracted ${archiveName} but none of [${binaryFileCandidates.join(', ')}] were inside it`,
    );
  }
  if (!isWin) await chmod(tmpBin, 0o755).catch(() => {});

  // ── 6. Code-signature ──
  yield { type: 'verifying', what: 'signature' };
  await stripQuarantine(tmpBin);
  const { result: signature, accepted } = await (opts.verifyOverride ?? verifyCodeSignature)(
    tmpBin,
    {
      policy,
    },
  );
  if (!accepted) {
    await rm(tmpExtractDir, { recursive: true, force: true });
    yield* fail(
      `engine binary failed signature policy '${policy}': ${signature.status}${signature.detail ? ` (${signature.detail})` : ''}`,
    );
  }

  // ── 7. Atomic publish + sentinel ──
  await rm(cacheDir, { recursive: true, force: true });
  await rename(tmpExtractDir, cacheDir);
  await writeFile(
    sentinelPath,
    `${JSON.stringify(
      {
        engine,
        version,
        assetPlatformKey,
        archiveName,
        archiveSha: actualSha,
        signature,
        verifiedAt: nowIso(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // ── 8. Stamp env so the providers (and discoverNativeBinaries) find it ──
  stampEnv(engine, binPath, variant, versionDir);
  log.info(
    `[engine-resolver] resolved ${engine} (${assetPlatformKey}) → ${binPath} [sig=${signature.status}]`,
  );
  yield { type: 'done', binPath, cached: false };
  return { binPath, cached: false, signature, version, assetPlatformKey };
}

/**
 * Drain {@link resolveEngine} to its terminal result. Forwards each event
 * to `onEvent`; throws {@link EngineUnavailableError} on a handled failure.
 */
export async function resolveEngineToCompletion(
  opts: ResolveEngineOptions,
  onEvent?: (e: EngineResolveEvent) => void,
): Promise<EngineResolveResult> {
  const gen = resolveEngine(opts);
  while (true) {
    const step = await gen.next();
    if (step.done) return step.value;
    onEvent?.(step.value);
  }
}

// ── helpers ──

/** Yield a terminal error event, then throw on the next pull. */
async function* fail(message: string): AsyncGenerator<EngineResolveEvent, never, void> {
  yield { type: 'error', error: message };
  throw new EngineUnavailableError(message);
}

function stripVer(v: string): string {
  return v.replace(/^native-v/, '').replace(/^v/, '');
}

function stampEnv(
  engine: NativeBinaryName,
  binPath: string,
  variant: string | undefined,
  versionDir: string,
): void {
  process.env[ENGINE_ENV_VAR[engine]] = binPath;
  // Also point discoverNativeBinaries at the cache root so sibling engines
  // resolve from the same place on a later boot.
  process.env.GEZEL_NATIVE_BIN_DIR = versionDir;
  if (engine === 'llama-server' && variant) process.env.GEZEL_LLAMA_SERVER_BACKEND = variant;
}

async function resolveGithubToken(): Promise<string | null> {
  if (process.env.GEZEL_GITHUB_TOKEN) return process.env.GEZEL_GITHUB_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function makeAuthedFetch(base: typeof fetch, token: string | null): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    base(input, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        Accept: 'application/octet-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })) as typeof fetch;
}

async function ghJson(
  url: string,
  fetchImpl: typeof fetch,
  token: string | null,
): Promise<GhRelease> {
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    throw new EngineUnavailableError(
      `GitHub API returned ${res.status} for ${url}${res.status === 404 ? ' (release not found — or no access while private)' : ''}`,
    );
  }
  return (await res.json()) as GhRelease;
}

async function ghBytes(
  assetApiUrl: string,
  fetchImpl: typeof fetch,
  token: string | null,
): Promise<Buffer> {
  const res = await fetchImpl(assetApiUrl, {
    headers: {
      Accept: 'application/octet-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok)
    throw new EngineUnavailableError(`asset download returned ${res.status} for ${assetApiUrl}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Parse `sha256sum`-style lines: `<64-hex>␠␠[*]<filename>`. */
function parseSums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    const sha = m?.[1];
    const name = m?.[2];
    if (sha && name) map.set(name.trim(), sha.toLowerCase());
  }
  return map;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function readSentinelSignature(path: string): Promise<SignatureResult> {
  try {
    const j = JSON.parse(await readFile(path, 'utf8')) as { signature?: SignatureResult };
    return j.signature ?? { status: 'unsupported' };
  } catch {
    return { status: 'unsupported' };
  }
}
