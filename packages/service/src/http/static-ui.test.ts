import { describe, expect, it } from 'vitest';
import { mimeTypeForPath } from './mime.js';
import {
  UI_DOCUMENT_CACHE_CONTROL,
  UI_IMMUTABLE_ASSET_CACHE_CONTROL,
  shouldServeUiShell,
  staticUiCacheControl,
} from './static-ui.js';

describe('static UI responses', () => {
  it('revalidates the HTML shell and caches Vite assets immutably', () => {
    expect(staticUiCacheControl('index.html')).toBe(UI_DOCUMENT_CACHE_CONTROL);
    expect(staticUiCacheControl('assets/TerminalCodeEditor-D7EVHAoe.js')).toBe(
      UI_IMMUTABLE_ASSET_CACHE_CONTROL,
    );
  });

  it('uses the SPA fallback for client routes but not missing files', () => {
    expect(shouldServeUiShell('projects/gezel')).toBe(true);
    expect(shouldServeUiShell('assets/TerminalCodeEditor-old.js')).toBe(false);
    expect(shouldServeUiShell('assets/missing-extensionless-chunk')).toBe(false);
    expect(shouldServeUiShell('favicon.svg')).toBe(false);
  });

  it('serves the proofing engine as WebAssembly, and 404s a missing one', () => {
    // Both binaries ship: the full engine finds its slim sibling by
    // substituting the filename in its own URL, so they must sit side by
    // side under the same directory with their real names.
    for (const name of ['harper_wasm_bg.wasm', 'harper_wasm_slim_bg.wasm']) {
      expect(mimeTypeForPath(`harper/${name}`)).toBe('application/wasm');
      // A missing binary must fall through to a clean 404 rather than the
      // SPA shell. `200 text/html` for a .wasm path surfaces inside the
      // worker as a confusing WASM compile error instead of "not found".
      expect(shouldServeUiShell(`harper/${name}`)).toBe(false);
    }
  });
});
