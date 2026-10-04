import type { EmbeddingPackageManifest } from '@bendyline/gezel/app-models';
export type { EmbeddingPackageManifest } from '@bendyline/gezel/app-models';
export function writeEmbeddingManifest(root?: string): Promise<EmbeddingPackageManifest>;
export function verifyCapacitorPackage(root?: string): Promise<EmbeddingPackageManifest>;
export function verifyRuntime(root: string, target: 'ios' | 'android'): Promise<unknown>;
export function stageNative(
  target: 'ios' | 'android',
  source: string,
  destination?: string,
): Promise<void>;

export function configureCapacitorProject(options: {
  projectRoot: string;
  platform: 'ios' | 'android';
  sdkRoot?: string;
}): Promise<{ changed: string[]; compatibility: EmbeddingPackageManifest }>;
