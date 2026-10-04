export interface ElectronNativeStageOptions {
  platform: NodeJS.Platform;
  arch: string;
  destination: string;
  cache: string;
  fetchImpl?: typeof fetch;
  allowUnavailable?: boolean;
}
export interface NativeArchivePin {
  name: string;
  sha256: string;
  platformKey: string;
}
export function stageElectronNative(
  options: ElectronNativeStageOptions,
): Promise<NativeArchivePin[]>;
