/**
 * `@bendyline/gezel-service/gezapp` — the AI App authoring surface,
 * importable without booting the daemon (mirrors the `./handboek`
 * subpath pattern). The CLI's `gezel app validate|pack|new|schemas`
 * commands run entirely on this module.
 *
 * Installation (`importGezapp`) is deliberately NOT exported here: the
 * registry under `~/.gezel/ai-apps/` has exactly one writer, the
 * running daemon.
 */

export {
  GEZAPP_MAX_ARCHIVE_BYTES,
  GEZAPP_MAX_FILE_BYTES,
  GEZAPP_MAX_FILES,
  GEZAPP_MAX_UNCOMPRESSED_BYTES,
  type ReadGezappResult,
  type VerifyGezappResult,
  buildGezappArchive,
  readGezapp,
  verifyGezapp,
} from './project-type/gezapp.js';
export {
  type AssembledGezappSource,
  type GezappSourceFinding,
  type GezappSourceOptions,
  GezappSourceError,
  type PackGezappFromSourceResult,
  type ValidateGezappSourceResult,
  assembleGezappSource,
  isGezappSourceDir,
  packGezappFromSource,
  renderGezappAuthoringSchemaFiles,
  validateGezappSource,
} from './project-type/gezapp-source.js';
