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

  const shutdown = async (signal: string) => {
    process.stderr.write(`\ngezeld received ${signal}, shutting down\n`);
    await running.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows: gezel-service-host stops the GezelService child by sending
  // CTRL_BREAK to its process group (Node surfaces it as SIGBREAK) —
  // kill('SIGTERM') on Windows is an abrupt TerminateProcess, so this is
  // the only graceful-stop path under the machine service.
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));

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
