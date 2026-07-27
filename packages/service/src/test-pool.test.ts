import { describe, expect, it } from 'vitest';

/**
 * Guards the fork flag added in vitest.config.ts after three "Worker exited
 * unexpectedly" crashes whose reports all showed V8 aborting with a fatal
 * zone OOM inside `ExecuteTurboshaftWasmCompilation` — background tier-up of a
 * web-tree-sitter grammar. If the flag ever stops reaching the workers, the
 * suite goes back to dying at random with all tests reported green.
 */
describe('vitest fork flags', () => {
  it('runs test workers with wasm tier-up disabled', () => {
    expect(process.execArgv).toContain('--no-wasm-tier-up');
  });
});
