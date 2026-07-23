/**
 * Compatibility shim — the renderer now lives in ./draw/ (pipeline passes)
 * with colors in ./palette.ts and deterministic seeding in ./seed.ts.
 */
export type { RenderState } from './draw/index.js';
export { render } from './draw/index.js';
export type { CityPalette as MapPalette } from './palette.js';
export { ageBucket } from './palette.js';
export { hueFromString } from './seed.js';
