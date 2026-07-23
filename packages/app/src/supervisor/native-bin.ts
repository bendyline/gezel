import { existsSync } from 'node:fs';
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
  const devRoot = dirname(fileURLToPath(mainMetaUrl)); // packages/app/dist
  const repoRoot = resolve(devRoot, '..', '..', '..');
  const devBuild = join(repoRoot, 'native', 'build');

  if (variant) {
    const variantKey = `${PLATFORM_KEY}-${variant}`;
    dirs.push(join(asarRoot, variantKey));
    dirs.push(join(devBuild, variantKey));
  }
  // Variant-less fallback covers single-variant engines (sd-cpp) and
  // platforms where only one variant exists (Mac always picks Metal).
  dirs.push(join(asarRoot, PLATFORM_KEY));
  dirs.push(join(devBuild, PLATFORM_KEY));

  // Directory precedence is the outer loop; within each dir the gezel-
  // prefixed name wins over the legacy bare name.
  for (const dir of dirs) {
    for (const fileName of fileNames) {
      const p = join(dir, fileName);
      if (existsSync(p)) return p;
    }
  }
  return null;
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
