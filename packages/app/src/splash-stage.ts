/**
 * Which supervisor log lines the startup splash surfaces, and the
 * plain-language stage each one means. Pure policy, kept out of main.ts so it
 * can be tested without booting Electron (same split as electron-boundaries).
 *
 * Deliberately a small allowlist rather than echoing the log. The supervisor
 * is chatty and its lines name internals — "mode=embedded (forced)",
 * "bundled sd-server: …\\native-bin\\win32-x64\\gezel-sd-server.exe" — that
 * mean nothing to the person waiting for the app to open. An unmatched line
 * leaves the previous stage on screen, so the splash never flickers through
 * noise or blanks out mid-wait.
 *
 * This exists because first launch is slow: `connectOrStart` unpacks the
 * service bundle and provisions the bundled Node/pnpm runtimes before the UI
 * can load, which measured ~156s on a cold Windows machine in the release-
 * candidate audit. The window is painted up front now, and these lines are
 * what make that wait read as progress rather than a hang.
 */

/**
 * Ordered most-specific first; the first match wins.
 *
 * `text` may be a function of the match so a stage can carry a number the
 * supervisor measured. Naming the minutes was enough while extraction was
 * tens of seconds; on a cold Linux arm64 install it ran to twenty minutes,
 * and a caption that never changes over twenty minutes is indistinguishable
 * from a hung process no matter what it says. A percentage that keeps moving
 * is the difference between waiting and giving up.
 */
export const SPLASH_STAGES: ReadonlyArray<{
  readonly match: RegExp;
  readonly text: string | ((m: RegExpMatchArray) => string);
}> = [
  // Must precede the generic extraction stage below. The opening
  // "extracting service bundle v1.2.3 to /path" line has no percentage and
  // falls through to it; every subsequent progress line matches here.
  {
    match: /extracting service bundle\D+(\d{1,3})%/i,
    text: (m) => `Setting up Gezel — ${m[1]}% unpacked`,
  },
  // The long pole on a cold install: ~33k files out of service-bundle.tar.gz
  // after runtime pruning (down from ~46k). A same-session Windows benchmark
  // fell from 25.7s to 20.8s; a cold Defender scan can still take minutes.
  { match: /extracting service bundle/i, text: 'Setting up Gezel — first run takes a few minutes' },
  { match: /reusing the installer-extracted service tree/i, text: 'Setting up Gezel' },
  { match: /installing bundled (node|pnpm)/i, text: 'Setting up the bundled runtime' },
  { match: /(bound on|adopt(ed|ing)|health)/i, text: 'Almost ready' },
];

/** The user-facing stage a supervisor log line represents, or null to hold the current one. */
export function splashStage(line: string): string | null {
  for (const stage of SPLASH_STAGES) {
    const match = line.match(stage.match);
    if (!match) continue;
    return typeof stage.text === 'function' ? stage.text(match) : stage.text;
  }
  return null;
}
