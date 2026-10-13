/**
 * Public surface of the llama.cpp provider package. Other parts of
 * the service import from this barrel rather than reaching into
 * sub-files; the layout (`provider.ts`, `gguf-metadata.ts`,
 * `models.ts`, …) is internal.
 */

export {
  LlamaCppProvider,
  NativeEngineCrashedError,
  ToolCallAccumulator,
} from './provider.js';
// Re-exported for backwards compatibility — actual implementation lives
// in providers/openai-compatible/sse.ts, shared with MLX and any future
// OpenAI-compatible provider.
export { readSseEvents } from '../openai-compatible/sse.js';
export { readGgufSummary, type GgufSummary } from './gguf-metadata.js';
export {
  LlamaCppModelManager,
  type InstallEvent,
  type InstalledLlamaCppModel,
  type LlamaCppModelManagerOptions,
} from './models.js';
