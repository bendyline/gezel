import { createRequire } from 'node:module';
import type ts from 'typescript';

const require = createRequire(import.meta.url);
let loaded: typeof ts | undefined;

/**
 * The TypeScript compiler, loaded the first time a script is validated.
 * Imported at startup it was about 100 ms of every gezel-mcp child's ~560 ms
 * start, and most sessions never validate a script.
 */
export function typescript(): typeof ts {
  loaded ??= require('typescript') as typeof ts;
  return loaded;
}
