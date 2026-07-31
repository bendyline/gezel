import { describe, expect, it } from 'vitest';
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
});
