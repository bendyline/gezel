import { describe, expect, it } from 'vitest';

/**
 * Guards the fork flags added in vitest.config.ts after "Worker exited
 * unexpectedly" crashes showed V8 aborting with a fatal zone OOM while
 * compiling web-tree-sitter grammars. If either flag stops reaching the
 * workers, the suite goes back to dying at random with all tests reported
 * green.
 */
describe('vitest fork flags', () => {
  it('bounds wasm compilation in test workers', () => {
    expect(process.execArgv).toContain('--no-wasm-tier-up');
    expect(process.execArgv).toContain('--wasm-num-compilation-tasks=1');
  });
});
