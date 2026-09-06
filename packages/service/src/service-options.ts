import type { ServiceRole } from '@bendyline/gezel';
import type { ServerType } from '@hono/node-server';
import type { LoopbackCert } from './http/cert.js';
import type { ServiceContext } from './http/context.js';
import type { EngineContext } from './http/engine-context.js';
import type { UnexpectedHttpErrorHandler } from './http/errors.js';

/**
 * Canonical fixed port for the Gezel daemon. `6228` spells "MAAT" on a
 * phone keypad (M-A-A-T → 6-2-2-8). "Maat" is Dutch for a mate, companion,
 * or fellow worker — a close sibling to "gezel". It sits in the IANA User
 * Port range and below the default ephemeral-allocation windows on Windows,
 * macOS, and Linux.
 *
 * Who holds it depends on the install. On machine installs the INSTALLERS
 * pin the machine-engine broker here (`GEZEL_PORT=6228`), so 6228 answers
 * with the compute broker — not the product `/v1` API — and third-party
 * clients that land on it get an actionable redirect envelope (see
 * http/machine-engine-hints.ts). User-facing daemons (standalone `gezeld`,
 * the embedded desktop service, `gezel start` when no machine service is
 * registered) prefer this port so that on installs WITHOUT a machine
 * service, third-party OpenAI-compatible clients — the ones we don't ship
 * and can't teach to read the runtime files — get a stable
 * `https://127.0.0.1:6228/v1` base URL. It's a strong default, not a
 * guarantee: if the port is taken the daemon falls back to an ephemeral
 * port. The *actual* bound port is always written to
 * `<home>/runtime/port`, which is the only universally-correct discovery;
 * the Ollama-emulation listener (fixed 11434, opt-in) is the stable-port
 * alternative for third-party apps on machine installs. Force an exact
 * port (no fallback) with `--port` / `GEZEL_PORT`.
 */
export const DEFAULT_PORT = 6228;

export interface StartServiceOptions {
  /**
   * Responsibility of this daemon. Installed machine services use
   * `machine-engine`; Electron-owned daemons use `user`. `legacy-full` exists
   * only so a new supervisor can safely coexist with an older installation.
   */
  role?: ServiceRole;
  /** Test seam for a split-service pair; production discovers the OS path. */
  machineEngineHome?: string;
  /**
   * Whether a user daemon should discover and adopt the installed machine
   * engine. Defaults to true in production; the desktop dev supervisor turns
   * it off so `pnpm app` exercises workspace-built native-provider code.
   */
  machineEngineDiscovery?: boolean;
  home?: string;
  /**
   * Bind to this exact port and FAIL if it's already in use (no
   * fallback). Set from `--port` / `GEZEL_PORT`. A named port that
   * silently moved would make the advertised base URL a lie, so an
   * explicit request is honored or it errors. When omitted, the port is
   * chosen per {@link preferCanonicalPort}.
   */
  port?: number;
  /**
   * When `port` is omitted, try to claim the canonical {@link DEFAULT_PORT}
   * (so third-party OpenAI-compatible clients have a stable base URL),
   * falling back to an ephemeral port if it's already taken. The
   * user-facing daemons (standalone `gezeld`, embedded desktop service)
   * set this; tests and library embedders leave it off and get a pure
   * ephemeral port, avoiding contention on one fixed port across parallel
   * suites.
   */
  preferCanonicalPort?: boolean;
  uiDir?: string;
  /**
   * Enable browser web-UI mode: mint a dedicated per-launch token for
   * the browser (written to `runtime/web-ui-token`) so the CLI can print
   * a one-time `?token=` URL without exposing the root token. Defaults to
   * `process.env.GEZEL_WEB === '1'` (how the CLI's `--web` flag turns it
   * on for the spawned daemon). Independent of transport — pair with
   * `GEZEL_INSECURE_TRANSPORT=1` for the recommended HTTP-loopback story.
   */
  webUi?: boolean;
  /**
   * Optional callback the service can invoke to ask the supervisor to
   * restart it (with `reason` for diagnostics). Wired by the Electron
   * supervisor for embedded + spawned modes; absent for standalone
   * launches like the CLI daemon (where restart is the user's concern).
   * Currently used only by the folders move worker after a successful
   * config swap.
   */
  onRestartRequested?: (reason: string) => void;
  /**
   * Observe unexpected errors at the HTTP boundary. Intended for hosts and
   * smoke-test harnesses that must turn daemon-side 5xx responses into a
   * failing health signal instead of relying on log scraping.
   */
  onUnexpectedHttpError?: UnexpectedHttpErrorHandler;
  /**
   * Test seam: bind the opt-in Ollama emulation listener to this port
   * instead of the well-known 11434 (`0` = ephemeral). Production
   * launches leave it unset — emulating Ollama anywhere else defeats
   * the point.
   */
  ollamaEmulationPort?: number;
  /** Test seam for the managed Codex profile root (defaults to `$CODEX_HOME` / `~/.codex`). */
  codexHome?: string;
  /** Exact Codex bridge port override (`0` = ephemeral); production derives one from `home`. */
  codexBridgePort?: number;
  /** Exact OpenCode bridge port override (`0` = ephemeral); production derives one from `home`. */
  opencodeBridgePort?: number;
  /** Override pi's fixed loopback bridge port. Tests bind ephemeral ports. */
  piBridgePort?: number;
  /** Override pi's own agent directory. Tests must never write to a real one. */
  piAgentDir?: string;
  /** Override VS Code's fixed loopback bridge port. Tests bind ephemeral ports. */
  vscodeBridgePort?: number;
  /** Override VS Code's User/profile directory. Tests must never write to a real one. */
  vscodeUserDir?: string;
}

export interface RunningService<C extends EngineContext = ServiceContext> {
  context: C;
  server: ServerType;
  port: number;
  /**
   * First-party client credential written to `runtime/auth-token`. A user
   * daemon hands it to Electron; a machine engine exposes only its narrowly
   * scoped inference/model-management credential to the trusted user-daemon
   * bridge. It is deliberately distinct from `context.token`, which remains
   * process-local.
   */
  clientToken: string;
  /**
   * The per-launch loopback TLS cert. Populated whenever the daemon is
   * serving HTTPS (the default); `null` when downgraded via
   * `GEZEL_INSECURE_TRANSPORT=1`. Embedded-mode supervisors hand the
   * fingerprint straight to Electron's `setCertificateVerifyProc`
   * without round-tripping through disk.
   */
  cert: LoopbackCert | null;
  /**
   * The per-launch web-UI token when web mode is on (see
   * {@link StartServiceOptions.webUi}); `null` otherwise. Mirrors the
   * value written to `runtime/web-ui-token`. Handy for tests and for the
   * CLI to compose the printed browser URL.
   */
  webUiToken: string | null;
  stop: () => Promise<void>;
}
export type RunningEngineService = RunningService<EngineContext>;
