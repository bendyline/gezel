/**
 * Public surface of the MLX provider package. Other parts of the
 * service import from this barrel rather than reaching into sub-files;
 * the layout (`provider.ts`, `models.ts`, `config-parser.ts`,
 * `stdout-parser.ts`) is internal.
 */

export { MlxProvider } from './provider.js';
export { readMlxSummary, type MlxModelSummary } from './config-parser.js';
export {
  MlxModelManager,
  type MlxInstallEvent,
  type InstalledMlxModel,
  type MlxModelManagerOptions,
} from './models.js';
export { MLX_DEFAULT_PACKAGE_SPEC, MLX_VENV_NAME, mlxVenvPackages } from './venv.js';
