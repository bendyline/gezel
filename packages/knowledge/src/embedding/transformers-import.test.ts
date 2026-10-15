import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  TRANSFORMERS_MODULE,
  TransformersDependencyMissingError,
  unresolvedSpecifier,
} from './transformers-import.js';

function esmNotFound(specifier: string, importer: string): Error {
  const err = new Error(`Cannot find package '${specifier}' imported from ${importer}`);
  (err as Error & { code: string }).code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

describe('unresolvedSpecifier', () => {
  it('names transformers when the package itself is absent', () => {
    const err = esmNotFound(TRANSFORMERS_MODULE, '/x/profile-embedder.js');
    expect(unresolvedSpecifier(err)).toBe(TRANSFORMERS_MODULE);
  });

  it('names the dependency when transformers is present but its import is not', () => {
    // The shape of the incident: transformers resolved, its own import did not.
    const err = esmNotFound(
      'onnxruntime-common',
      '/x/node_modules/@huggingface/transformers/dist/transformers.node.mjs',
    );
    expect(unresolvedSpecifier(err)).toBe('onnxruntime-common');
  });

  it("reads the CommonJS resolver's error too", () => {
    let thrown: unknown;
    try {
      createRequire(import.meta.url)('gezel-no-such-package-for-this-test');
    } catch (err) {
      thrown = err;
    }
    expect(unresolvedSpecifier(thrown)).toBe('gezel-no-such-package-for-this-test');
  });

  it('ignores failures that are not resolution failures', () => {
    expect(
      unresolvedSpecifier(new Error(`Cannot find package '${TRANSFORMERS_MODULE}' in the cache`)),
    ).toBeNull();
    expect(unresolvedSpecifier(new TypeError('x is not a function'))).toBeNull();
    expect(unresolvedSpecifier('Cannot find module')).toBeNull();
  });
});

describe('TransformersDependencyMissingError', () => {
  it('names the missing dependency and keeps the original error', () => {
    const cause = esmNotFound('onnxruntime-common', '/x/transformers.node.mjs');
    const err = new TransformersDependencyMissingError('onnxruntime-common', '^4.3.1', cause);
    expect(err.message).toContain(`${TRANSFORMERS_MODULE} is installed but cannot load`);
    expect(err.message).toContain("'onnxruntime-common'");
    expect(err.message).not.toMatch(/not installed/);
    expect(err.missing).toBe('onnxruntime-common');
    expect(err.isActionable).toBe(true);
    expect(err.cause).toBe(cause);
  });
});
