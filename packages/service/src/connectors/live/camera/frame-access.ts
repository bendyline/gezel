/**
 * Who may see a camera's pictures. Pixels from a camera's event records
 * reach the person's own app and gezels running on this computer; a gezel on
 * a cloud model gets a local description instead, unless the person turned
 * on "Let cloud AI see these pictures" for that camera. Saved frames are not
 * in the artifacts drawer at all, so only event keyframes need this check.
 *
 * Decide on the file a read will open, not on the path a model wrote. The
 * first version compared the raw string with the corpus folder, and the
 * readers then normalized it, so `data/./mud-room/…`, `data//…`,
 * `x/../data/…`, another letter case, or on Windows a trailing dot or an
 * 8.3 short name sent a keyframe to a cloud model with sharing off
 * (1.26299.99 audit). {@link cameraBindingForFile} compares real paths; the
 * lexical {@link cameraBindingForArtifact} remains for callers that hold only
 * a ref, and folds what it can.
 */

import { realpath } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import type { ProjectConnectorBinding, ProviderName } from '@bendyline/gezel';
import { isLocalProvider, parseCameraBindingConfig } from '@bendyline/gezel';
import { isPathInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';

type CameraProject = { connectors?: ProjectConnectorBinding[] };

function cameraBindings(project: CameraProject): ProjectConnectorBinding[] {
  return project.connectors?.filter((b) => b.driver === 'device' && !!b.corpusDir) ?? [];
}

/**
 * An artifact path as the readers will resolve it, case-folded. Folding on
 * every platform withholds, at worst, a same-named file on a case-sensitive
 * volume; Windows' trailing dots and spaces are dropped for the same reason.
 */
function artifactKey(raw: string): string {
  const normalized = posix
    .normalize(raw.replace(/\\/g, '/'))
    .split('/')
    .map((segment) =>
      segment === '.' || segment === '..' ? segment : segment.replace(/[. ]+$/, ''),
    )
    .join('/')
    .replace(/^(?:\.\/|\/)+/, '')
    .replace(/^artifacts(?:\/|$)/i, '')
    .replace(/\/+$/, '');
  return normalized.toLowerCase();
}

/** The camera binding whose corpus holds this artifact path, if any. */
export function cameraBindingForArtifact(
  project: CameraProject,
  artifactPath: string,
): ProjectConnectorBinding | undefined {
  const path = artifactKey(artifactPath);
  return cameraBindings(project).find((b) => {
    const dir = artifactKey(b.corpusDir!);
    return path === dir || path.startsWith(`${dir}/`);
  });
}

async function canonicalPath(path: string): Promise<string> {
  const real = await realpath(path).catch(() => resolve(path));
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

/**
 * The camera binding whose corpus holds `file`, an absolute path a reader is
 * about to open. Real paths resolve case, `.`/`..`, links, short names and
 * stream suffixes the way the read itself will.
 */
export async function cameraBindingForFile(
  project: CameraProject,
  artifactsDir: string,
  file: string,
): Promise<ProjectConnectorBinding | undefined> {
  const bindings = cameraBindings(project);
  if (bindings.length === 0) return undefined;
  const target = await canonicalPath(file);
  for (const binding of bindings) {
    const dir = await canonicalPath(join(artifactsDir, binding.corpusDir!));
    if (isPathInside(target, dir)) return binding;
  }
  return undefined;
}

/** Whether a camera allows cloud models to see its pictures. */
export function cameraAllowsCloud(binding: ProjectConnectorBinding): boolean {
  return parseCameraBindingConfig(binding.config).allowCloudModels;
}

function withheldFrom(
  binding: ProjectConnectorBinding | undefined,
  provider: ProviderName | undefined,
): boolean {
  if (!binding || cameraAllowsCloud(binding)) return false;
  return !provider || !isLocalProvider(provider);
}

/**
 * Whether the pixels at `ref` (an `artifacts/…` image ref or an artifact
 * path) must be kept from a session on `provider`. Lexical only; prefer
 * {@link cameraPixelsWithheldForFile} wherever the file is known.
 */
export function cameraPixelsWithheld(
  project: CameraProject,
  provider: ProviderName | undefined,
  ref: string,
): boolean {
  return withheldFrom(cameraBindingForArtifact(project, ref), provider);
}

/** {@link cameraPixelsWithheld} for the absolute file a reader will open. */
export async function cameraPixelsWithheldForFile(
  project: CameraProject,
  provider: ProviderName | undefined,
  artifactsDir: string,
  file: string,
): Promise<boolean> {
  return withheldFrom(await cameraBindingForFile(project, artifactsDir, file), provider);
}
