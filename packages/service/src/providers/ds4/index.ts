/**
 * Public surface of the ds4 (DwarfStar) provider package. See
 * {@link Ds4Provider} for the composition-over-llama.cpp rationale.
 * The supervisor launch wiring lives in `build-provider.ts`; ds4 GGUF
 * install/resolve reuses
 * {@link LlamaCppModelManager} (ds4 weights are GGUF) pointed at the
 * `engines/ds4/models` directory.
 */
export { Ds4Provider } from './provider.js';
