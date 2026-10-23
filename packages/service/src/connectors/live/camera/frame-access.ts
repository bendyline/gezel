/**
 * Who may see a camera's pictures. Pixels from a camera's event records
 * reach the person's own app and gezels running on this computer; a gezel on
 * a cloud model gets a local description instead, unless the person turned
 * on "Let cloud AI see these pictures" for that camera. Saved frames are not
 * in the artifacts drawer at all, so only event keyframes need this check.
 */

import type { ProjectConnectorBinding, ProviderName } from '@bendyline/gezel';
import { isLocalProvider, parseCameraBindingConfig } from '@bendyline/gezel';

/** The camera binding whose corpus holds this artifact path, if any. */
export function cameraBindingForArtifact(
  project: { connectors?: ProjectConnectorBinding[] },
  artifactPath: string,
): ProjectConnectorBinding | undefined {
  const path = artifactPath
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/^artifacts\//i, '');
  return project.connectors?.find(
    (b) =>
      b.driver === 'device' &&
      !!b.corpusDir &&
      (path === b.corpusDir || path.startsWith(`${b.corpusDir}/`)),
  );
}

/** Whether a camera allows cloud models to see its pictures. */
export function cameraAllowsCloud(binding: ProjectConnectorBinding): boolean {
  return parseCameraBindingConfig(binding.config).allowCloudModels;
}

/**
 * Whether the pixels at `ref` (an `artifacts/…` image ref or an artifact
 * path) must be kept from a session on `provider`.
 */
export function cameraPixelsWithheld(
  project: { connectors?: ProjectConnectorBinding[] },
  provider: ProviderName | undefined,
  ref: string,
): boolean {
  const binding = cameraBindingForArtifact(project, ref);
  if (!binding || cameraAllowsCloud(binding)) return false;
  return !provider || !isLocalProvider(provider);
}
