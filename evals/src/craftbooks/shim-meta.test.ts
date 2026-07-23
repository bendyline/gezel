import { parseScriptMeta } from '@bendyline/gezel-service';
import { describe, expect, it } from 'vitest';
import { loadCraftbookTestSpecsSync } from './test-spec-loader.ts';

/**
 * Every cli-shim script shipped in a craftbook `test.json` must parse
 * with the SERVICE's own meta parser — the exact code path
 * `POST /scripts/run` uses at trial time. A shim that fails here would
 * otherwise surface mid-trial as an opaque run failure after the model
 * has already burned repair attempts. Wild-caught (craftbook-week-plan:
 * an unescaped apostrophe inside a single-quoted description string
 * broke the string literal and produced four 500s in a live trial).
 */
describe('craftbook test.json cli shims', () => {
  it('every shim parses with the service script-meta parser', () => {
    const failures: string[] = [];
    let shims = 0;
    for (const { craftbookId, spec } of loadCraftbookTestSpecsSync()) {
      for (const mock of spec.mocks) {
        if (mock.kind !== 'cli') continue;
        shims++;
        try {
          const meta = parseScriptMeta(mock.shim.content, `${craftbookId}/${mock.shim.path}`);
          const expectedName = mock.shim.path
            .replace(/^scripts\//, '')
            .replace(/\.(ts|mjs|js)$/, '');
          if (meta.name !== expectedName) {
            failures.push(
              `${craftbookId}: shim meta.name "${meta.name}" != path-derived name "${expectedName}" (run_script resolves by filename)`,
            );
          }
        } catch (err) {
          failures.push(`${craftbookId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    expect(shims).toBeGreaterThan(15);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
