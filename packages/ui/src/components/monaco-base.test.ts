import { describe, expect, it, vi } from 'vitest';

// Worker routing is orthogonal to the contribution-order regression. Keeping
// its five worker entry points out of this test also keeps the assertion from
// waiting on unrelated Vite transforms while the full suite runs in parallel.
vi.mock('../squisq-monaco-workers.js', () => ({}));

Object.defineProperty(document, 'queryCommandSupported', {
  configurable: true,
  value: () => false,
});

// Monaco's large dependency graph is transformed while Vitest collects the
// file, rather than consuming this regression assertion's execution timeout.
const squisqMonaco = await import('@bendyline/squisq-editor-react/monaco');

describe('shared Monaco runtime', () => {
  it('does not register full-editor contributions after Squisq initializes services', async () => {
    // Reproduce the load order that triggered the packaged-app failure: a
    // Squisq editor initializes Monaco first, then a Gezel editor loads its
    // shared base. Importing editor.main in the second step would register
    // contributions whose singleton services missed the one-time snapshot.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({
        webkitBackingStorePixelRatio: 1,
        measureText: () => ({ width: 8 }),
      }),
    });
    // Keep the expensive Monaco module transform in Vitest's collection phase,
    // outside this test's timeout; only service initialization must be ordered.
    const seedModel = squisqMonaco.editor.createModel('', 'plaintext');
    let editor: ReturnType<typeof squisqMonaco.editor.create> | null = null;

    try {
      const { monaco, registerGezelMonacoThemes } = await import('./monaco-base.js');
      registerGezelMonacoThemes();
      const host = document.createElement('div');
      document.body.append(host);
      editor = monaco.editor.create(host, {
        value: 'const answer = 42;',
        language: 'plaintext',
        automaticLayout: false,
      });

      expect(monaco.editor).toBe(squisqMonaco.editor);
      // Squisq's compact profile intentionally omits inlay hints. If a late
      // editor.main import sneaks back in, resolving this contribution throws
      // "UNKNOWN service IInlayHintsCache" after the seed model above has
      // frozen StandaloneServices.
      expect(editor.getContribution('editor.contrib.inlayHints')).toBeNull();
    } finally {
      editor?.dispose();
      seedModel.dispose();
    }
  }, 60_000);
});
