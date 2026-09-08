import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redirectAsarToUnpacked } from './extract-bundle.js';

/**
 * Resolve the per-platform bundled native-engine binary (if any) that
 * electron-builder laid under `app.asar.unpacked/native-bin/<platform>/`.
 * Used by the supervisor to set env vars so the service's
 * `createImageProvider` factory picks up the binary without any
 * hand-holding in packaged-mode launches.
 *
 * In dev mode (`packages/app` run outside Electron) the binary is
 * resolved relative to the repo root at
 * `native/build/<platform>/sd-server[.exe]`, so `pnpm app` picks up
 * a locally-built binary if one exists.
 *
 * Returns absolute path when found, null otherwise. The supervisor
 * tolerates a missing binary — the service falls back to the default
 * loopback URL and renders a clear error when a user tries to generate
 * an image.
 */

const PLATFORM_KEY = resolvePlatformKey();

export interface ResolveNativeBinaryOptions {
  /** Prefer `native/build/` over the fetched/package-staging `native-bin/` tree. */
  preferDevelopmentBuild?: boolean;
  /** Skip candidates that do not satisfy a caller-owned compatibility check. */
  accept?: (path: string) => boolean;
}

export interface LlamaCheckoutCompatibility {
  compatible: boolean;
  reason: string;
  version?: string;
  build?: number;
  revision?: string;
}

/**
 * Resolve the on-disk path of a bundled native binary.
 *
 * `variant` is optional. When set, looks under
 * `<root>/<platform>-<variant>/<bin>` (Phase-2 multi-variant
 * engines like llama-cpp's CUDA/Vulkan/CPU builds). When unset,
 * falls back to `<root>/<platform>/<bin>` (single-variant engines
 * like sd-cpp). Variant lookup falls back to the variant-less path
 * if the variant directory doesn't exist — useful when only one
 * variant ships for a given platform (e.g. macOS Metal-only).
 */
export function resolveNativeBinaryPath(
  binaryName: 'sd-server' | 'llama-server' | string,
  mainMetaUrl: string,
  variant?: string,
  options: ResolveNativeBinaryOptions = {},
): string | null {
  if (!PLATFORM_KEY) return null;
  const ext = process.platform === 'win32' ? '.exe' : '';
  // Build scripts now emit the binary under a `gezel-` prefix (so the
  // running process shows as `gezel-llama-server` in Task Manager / GPU
  // listings — Gezel attribution, upstream lineage kept in the suffix).
  // Prefer that, but fall back to the bare upstream name so binaries
  // fetched or built BEFORE the rename still resolve. `binaryName` stays
  // the logical/upstream identifier (`llama-server`) everywhere else.
  const fileNames = [`gezel-${binaryName}${ext}`, `${binaryName}${ext}`];

  const dirs: string[] = [];
  // Primary: `<asarRoot>/<platform>[-<variant>]/` — packaged mode resolves
  // to `app.asar.unpacked/native-bin/`, dev mode to `packages/app/native-bin/`.
  // `scripts/fetch-native-binaries.mjs` and the release-electron CI workflow
  // both write here.
  const asarRoot = nativeBinDir(mainMetaUrl);
  // Secondary fallback: `<repo>/native/build/<platform>[-<variant>]/`
  // — the output dir of `native/engines/*/build.{sh,ps1}` for devs
  // who built an engine locally instead of fetching prebuilt.
  const devBuild = developmentNativeBinDir(mainMetaUrl);
  const roots = options.preferDevelopmentBuild ? [devBuild, asarRoot] : [asarRoot, devBuild];

  if (variant) {
    const variantKey = `${PLATFORM_KEY}-${variant}`;
    for (const root of roots) dirs.push(join(root, variantKey));
  }
  // Variant-less fallback covers single-variant engines (sd-cpp) and
  // platforms where only one variant exists (Mac always picks Metal).
  for (const root of roots) dirs.push(join(root, PLATFORM_KEY));

  // Directory precedence is the outer loop; within each dir the gezel-
  // prefixed name wins over the legacy bare name.
  for (const dir of dirs) {
    for (const fileName of fileNames) {
      const p = join(dir, fileName);
      if (existsSync(p) && (!options.accept || options.accept(p))) return p;
    }
  }
  return null;
}

/** `native/build/` in the source checkout containing the Electron main bundle. */
export function developmentNativeBinDir(mainMetaUrl: string): string {
  const mainDir = dirname(fileURLToPath(mainMetaUrl)); // packages/app/dist
  const repoRoot = resolve(mainDir, '..', '..', '..');
  return join(repoRoot, 'native', 'build');
}

/**
 * Prove that a candidate llama-server was built from the pin in THIS checkout.
 *
 * Dev builds may have two payloads on disk: a previously fetched native
 * release in `packages/app/native-bin/`, and a just-compiled binary in
 * `native/build/`. App source can begin passing new flags before the next
 * native release is published, so accepting the older fetched payload merely
 * because it is signed makes the dev app fail at first model launch. Check the
 * executable's own `--version` output and its sidecar against VERSION before
 * exposing it to the in-process service.
 */
export function verifyLlamaBinaryAgainstCheckoutPin(
  binaryPath: string,
  mainMetaUrl: string,
  runVersion: (path: string) => {
    status: number | null;
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
    error?: Error;
  } = defaultLlamaVersionRunner,
): LlamaCheckoutCompatibility {
  try {
    const repoRoot = resolve(developmentNativeBinDir(mainMetaUrl), '..', '..');
    const pinText = readFileSync(
      join(repoRoot, 'native', 'engines', 'llama-cpp', 'VERSION'),
      'utf8',
    );
    const tag = pinText.match(/^tag=(\S+)\s*$/m)?.[1];
    const buildText = pinText.match(/^build=(\d+)\s*$/m)?.[1];
    const revision = pinText.match(/^commit=([0-9a-f]{40})\s*$/m)?.[1]?.toLowerCase();
    if (!tag || !buildText || !revision) {
      return { compatible: false, reason: 'checkout llama.cpp VERSION pin is incomplete' };
    }

    const sidecar = JSON.parse(
      readFileSync(join(dirname(binaryPath), 'gezel-llama-build.json'), 'utf8'),
    ) as { engine?: unknown; revision?: unknown };
    if (sidecar.engine !== 'llama-cpp' || typeof sidecar.revision !== 'string') {
      return { compatible: false, reason: 'llama build sidecar is missing its source identity' };
    }
    if (sidecar.revision.toLowerCase() !== revision) {
      return {
        compatible: false,
        reason: `sidecar revision ${sidecar.revision} does not match checkout pin ${revision}`,
      };
    }

    const result = runVersion(binaryPath);
    if (result.error) {
      return { compatible: false, reason: `could not run --version: ${result.error.message}` };
    }
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) {
      return {
        compatible: false,
        reason: `--version exited with status ${result.status}${output.trim() ? `: ${output.trim()}` : ''}`,
      };
    }
    const match = output.match(
      /\bversion:\s*(\S+)\s+\(\s*build\s+(\d+)\s*,\s*commit\s+([0-9a-f]{7,40})\s*\)/i,
    );
    if (!match) {
      return { compatible: false, reason: '--version returned no recognizable source identity' };
    }

    const actualVersion = match[1]!;
    const actualBuild = Number.parseInt(match[2]!, 10);
    const actualRevision = match[3]!.toLowerCase();
    const expectedVersion = tag.match(/^v(.+)$/)?.[1];
    if (expectedVersion && actualVersion !== expectedVersion) {
      return {
        compatible: false,
        reason: `executable version ${actualVersion} does not match checkout pin ${expectedVersion}`,
      };
    }
    if (actualBuild !== Number.parseInt(buildText, 10)) {
      return {
        compatible: false,
        reason: `executable build ${actualBuild} does not match checkout pin ${buildText}`,
      };
    }
    if (!revision.startsWith(actualRevision)) {
      return {
        compatible: false,
        reason: `executable revision ${actualRevision} does not match checkout pin ${revision}`,
      };
    }

    return {
      compatible: true,
      reason: `llama.cpp ${actualVersion} build ${actualBuild}, revision ${actualRevision}`,
      version: actualVersion,
      build: actualBuild,
      revision: actualRevision,
    };
  } catch (error) {
    return {
      compatible: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function defaultLlamaVersionRunner(path: string): {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
} {
  const result = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * Directory containing per-platform subtrees. Electron resolves
 * relative paths next to the main process's own bundle; the
 * packaged asar-unpacked variant lives at
 * `<resourcesPath>/app.asar.unpacked/native-bin/`. Electron's patched
 * `fs` can read an unpacked file through its virtual `app.asar` path,
 * but `child_process.spawn` passes the path to the OS unchanged. Resolve
 * the real unpacked path here so embedded mode can execute the binary.
 */
export function nativeBinDir(mainMetaUrl: string): string {
  const mainDir = dirname(fileURLToPath(mainMetaUrl));
  return redirectAsarToUnpacked(resolve(mainDir, '..', 'native-bin'));
}

function resolvePlatformKey(): string | null {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  if (process.platform === 'linux') {
    if (process.arch === 'x64') return 'linux-x64';
    if (process.arch === 'arm64') return 'linux-arm64';
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'win32-x64';
  }
  return null;
}
