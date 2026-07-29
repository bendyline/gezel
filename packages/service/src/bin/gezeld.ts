import { existsSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startService } from '../service.js';

async function main() {
  const portArg = process.env.GEZEL_PORT ? Number.parseInt(process.env.GEZEL_PORT, 10) : undefined;
  // Normalize because the env var may carry doubled separators when set by
  // installers (NSIS' nssm wiring on Windows historically wrote
  // `C:\Program Files\gezel\\resources\\...`). `normalize` collapses those
  // to single separators so the UI router's path-prefix safety check
  // (`file.startsWith(uiDir)`) doesn't false-negative on every request.
  const rawUiDir = process.env.GEZEL_UI_DIR ?? findBundledUi();
  const uiDir = rawUiDir ? normalize(rawUiDir) : undefined;
  // No explicit GEZEL_PORT → claim the canonical well-known port (with
  // ephemeral fallback) so third-party OpenAI-compatible clients have a
  // stable base URL. A valid GEZEL_PORT forces that exact port.
  const explicitPort = Number.isFinite(portArg) ? portArg : undefined;
  const running = await startService({
    port: explicitPort,
    preferCanonicalPort: explicitPort === undefined,
    uiDir,
  });

  // More than one channel can request a stop (the service host closes
  // stdin *and* may send CTRL_BREAK), and `running.stop()` is not safe to
  // run twice — latch the first request and ignore the rest.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`\ngezeld received ${signal}, shutting down\n`);
    await running.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows: kill('SIGTERM') is an abrupt TerminateProcess, so a signal
  // is not a usable stop channel under the machine service. CTRL_BREAK
  // (surfaced as SIGBREAK) works only when the host has a console, which
  // the restricted service SID prevents — so stdin EOF below is the
  // primary path and this is the secondary.
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));

  // gezel-service-host hands us the read end of a pipe as stdin and holds
  // the write end; closing it is how the service requests a graceful
  // stop. Opt-in via env because a foreground `gezel start` inherits a
  // terminal whose stdin can end for reasons that are not a stop request.
  if (process.env.GEZEL_SHUTDOWN_ON_STDIN_EOF === '1') {
    process.stdin.on('end', () => void shutdown('stdin EOF'));
    process.stdin.on('error', () => void shutdown('stdin error'));
    // Flowing mode is what makes 'end' fire; resume() alone is enough
    // since we never care about the bytes. unref() keeps this handle from
    // being the reason the loop stays alive.
    process.stdin.resume();
    process.stdin.unref();
  }

  const scheme = running.cert ? 'https' : 'http';
  process.stderr.write(
    `gezeld listening on ${scheme}://127.0.0.1:${running.port} (home=${running.context.home})\n`,
  );
  // Web mode: surface the one-time browser URL on the daemon's own
  // stdout so foreground (`gezel start --web --foreground`) users see it
  // directly. The detached CLI path reads the same token from
  // `runtime/web-ui-token` to print + optionally open a browser.
  if (running.webUiToken) {
    process.stderr.write(
      `\n  Gezel web UI →  ${scheme}://127.0.0.1:${running.port}/?token=${running.webUiToken}\n\n`,
    );
  }
}

/**
 * When the service is packaged with a bundled UI, `@bendyline/gezel-ui` is copied
 * into `dist/ui/` at build time. In dev we look for a sibling `packages/ui/dist`
 * directory as a convenience.
 */
function findBundledUi(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../ui'),
    resolve(here, '../../ui'),
    resolve(here, '../../../ui/dist'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return undefined;
}

main().catch((err) => {
  // SingleInstanceError is an expected, actionable refusal (another daemon
  // already owns this home) — print just its message, not a stack.
  if (err instanceof Error && err.name === 'SingleInstanceError') {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`gezeld failed to start: ${err?.stack ?? err}\n`);
  }
  process.exit(1);
});
