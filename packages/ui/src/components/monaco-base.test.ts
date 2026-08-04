import { describe, expect, it } from 'vitest';

describe('shared Monaco runtime', () => {
  it('does not register full-editor contributions after Squisq initializes services', async () => {
    // Reproduce the load order that triggered the packaged-app failure: a
    // Squisq editor initializes Monaco first, then a Gezel editor loads its
    // shared base. Importing editor.main in the second step would register
    // contributions whose singleton services missed the one-time snapshot.
    Object.defineProperty(document, 'queryCommandSupported', {
      configurable: true,
      value: () => false,
    });
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
    const squisqMonaco = await import('@bendyline/squisq-editor-react/monaco');
    const seedModel = squisqMonaco.editor.createModel('', 'plaintext');
    let editor: ReturnType<typeof squisqMonaco.editor.create> | null = null;

    try {
      const { monaco } = await import('./monaco-base.js');
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
  });
});
