import type { SystemBootstrapStatus } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { systemStatusLabel, systemStatusTitle } from './HealthStrip.js';

const PNPM_FAILURE =
  'playwright install chromium exited with 1: 8a54ba75\\scratchpad\\ui-home\\bin\\node.exe" ' +
  '"C:\\Users\\someone\\AppData\\Local\\Gezel\\bin\\pnpm-runtime\\bin\\pnpm.mjs" install --prod\n' +
  '    at getFinalError (file:///C:/Users/someone/AppData/Local/Gezel/bin/pnpm-runtime/dist/pnpm.mjs:115719:14)';

describe('System Health runtime pill', () => {
  it('keeps the raw failure out of the label, which never wraps', () => {
    const status = { phase: 'error', error: PNPM_FAILURE } as SystemBootstrapStatus;
    expect(systemStatusLabel(status)).toBe('Runtime setup failed');
    expect(
      systemStatusLabel({
        phase: 'setup-incomplete',
        error: PNPM_FAILURE,
      } as SystemBootstrapStatus),
    ).toBe('Runtime toolsets not pinned');
  });

  it('puts the failure in the tooltip and says what happens next', () => {
    const title = systemStatusTitle({
      phase: 'error',
      error: PNPM_FAILURE,
    } as SystemBootstrapStatus);
    expect(title).toContain('playwright install chromium exited with 1');
    expect(title).toContain('Gezel tries again the next time it starts.');
  });

  it('caps a very long failure in the tooltip', () => {
    const title = systemStatusTitle({
      phase: 'error',
      error: 'x'.repeat(5_000),
    } as SystemBootstrapStatus);
    expect(title?.startsWith(`${'x'.repeat(600)}…`)).toBe(true);
  });

  it('has no tooltip while the runtime is healthy or still installing', () => {
    expect(systemStatusTitle({ phase: 'ready' } as SystemBootstrapStatus)).toBeUndefined();
    expect(
      systemStatusTitle({ phase: 'downloading-browser' } as SystemBootstrapStatus),
    ).toBeUndefined();
    expect(systemStatusTitle({ phase: 'error' } as SystemBootstrapStatus)).toBeUndefined();
  });
});
