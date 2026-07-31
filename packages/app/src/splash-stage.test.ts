import { describe, expect, it } from 'vitest';
import { splashStage } from './splash-stage.js';

describe('splashStage', () => {
  it('names the slow first-launch stages in plain language', () => {
    // Verbatim supervisor output from a cold packaged launch (v1.26211.26).
    // Naming the duration is deliberate: the extraction sits for minutes on a
    // cold install, and a caption that only says "unpacking" still reads as a
    // hang once it has been there past thirty seconds.
    expect(
      splashStage('[supervisor] extracting service bundle v1.26211.26 to C:\\x\\service'),
    ).toBe('Setting up Gezel — first run takes a few minutes');
    expect(splashStage('[supervisor] installing bundled node v24.18.1')).toBe(
      'Setting up the bundled runtime',
    );
    expect(splashStage('[supervisor] installing bundled pnpm v11.15.1')).toBe(
      'Setting up the bundled runtime',
    );
    expect(splashStage('[supervisor] embedded service bound on https://127.0.0.1:6228')).toBe(
      'Almost ready',
    );
  });

  it('holds the current stage rather than surfacing internals', () => {
    // Unmatched → null → the splash keeps whatever it was showing. These are
    // real lines that would otherwise leak paths and mode flags to the user.
    expect(splashStage('[supervisor] mode=embedded (forced)')).toBeNull();
    expect(
      splashStage(
        '[supervisor] bundled sd-server: C:\\Program Files\\gezel\\resources\\app.asar.unpacked\\native-bin\\win32-x64\\gezel-sd-server.exe',
      ),
    ).toBeNull();
    expect(splashStage('[app] gezel home: C:\\Users\\someone\\.gezel')).toBeNull();
    expect(splashStage('')).toBeNull();
  });

  it('never surfaces a path or a Windows drive letter', () => {
    // The splash is the first thing a new user sees; a leaked absolute path
    // reads as a crash dump. Guards the copy, not just the matching.
    for (const { text } of [
      { text: splashStage('[supervisor] extracting service bundle v1 to C:\\x') ?? '' },
      { text: splashStage('[supervisor] installing bundled node v24.18.1') ?? '' },
      { text: splashStage('[supervisor] embedded service bound on https://127.0.0.1:6228') ?? '' },
    ]) {
      expect(text).not.toMatch(/[a-z]:\\|\/{2}|\.exe|https?:/i);
      expect(text.length).toBeLessThanOrEqual(48);
    }
  });
});
