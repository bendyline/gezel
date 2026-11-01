/**
 * Startup hosts must be able to verify native payloads without importing the
 * daemon. In Electron, loading that dependency graph blocks the window's
 * event loop even when the service itself runs in a utility process.
 */
export {
  reuseVerifiedElectronNativeBinaries,
  verifyNativeBinaries,
  type ElectronNativeReuseOptions,
  type ElectronNativeReuseResult,
} from '@bendyline/gezel-inference/internal/engines/electron-native-reuse';
