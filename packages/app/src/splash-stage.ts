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

/** Ordered most-specific first; the first match wins. */
export const SPLASH_STAGES: ReadonlyArray<{ readonly match: RegExp; readonly text: string }> = [
  // The long pole on a cold install: ~33k files out of service-bundle.tar.gz
  // after runtime pruning (down from ~46k). A same-session Windows benchmark
  // fell from 25.7s to 20.8s; a cold Defender scan can still take minutes.
  // Naming the minutes is the point — a caption that says only "unpacking"
  // still reads as a hang once it has sat there past thirty seconds.
  { match: /extracting service bundle/i, text: 'Setting up Gezel — first run takes a few minutes' },
  { match: /installing bundled (node|pnpm)/i, text: 'Setting up the bundled runtime' },
  { match: /(bound on|adopt(ed|ing)|health)/i, text: 'Almost ready' },
];

/** The user-facing stage a supervisor log line represents, or null to hold the current one. */
export function splashStage(line: string): string | null {
  return SPLASH_STAGES.find((stage) => stage.match.test(line))?.text ?? null;
}
