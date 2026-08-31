import { createLogger } from '@bendyline/gezel';
import type { EnginePhaseEvent } from '../streaming-session.js';
import {
  type MlxFatalError,
  classifyMlxFatalErrorLine,
  classifyMlxStartupLine,
} from './stdout-parser.js';

const log = createLogger('mlx');

/**
 * Turns the supervised engine's stdout into per-session phase events, and
 * decides when a line means the engine is broken.
 *
 * Extracted from `MlxProvider` because it is one concern with its own state
 * machine and its own hard-won rules, and because a supervised engine has ONE
 * stdout shared by every session on it — so "who hears this line" is a real
 * question, not an implementation detail of the provider.
 */
export interface EngineLogRouterDeps {
  /**
   * Friendly model name for the long weight-load window, so the pill reads
   * "Loading model — Qwen 3.5" rather than a bare "Loading weights". Read
   * lazily: the catalog may resolve it after the router is built.
   */
  modelDisplayName?: () => string | undefined;
  /** Hand a classified phase to whoever should hear it. */
  deliver: (phase: EnginePhaseEvent) => void;
  /**
   * The engine broke before it ever served. Fires once per fatal (first-seen
   * wins); the caller tears the child down so the next `ensureRunning()`
   * respawns fresh.
   */
  onFatal: (fatal: MlxFatalError) => void;
  /** A `ready` phase survived the repeat filter. */
  onReady: () => void;
}

export class EngineLogRouter {
  /** Last phase delivered, for the repeat filter. Cleared by `ready`. */
  private lastStartupPhase: EnginePhaseEvent | null = null;
  /**
   * Latest fatal error seen before the engine served. The server's httpd keeps
   * accepting connections after `_generate` dies, so `/health` cannot be
   * trusted; while this is non-null a send short-circuits instead of hanging
   * on an unresponsive completions endpoint. Cleared on `starting`.
   */
  private fatalError: MlxFatalError | null = null;
  /**
   * Whether the engine has reported itself ready and is therefore serving.
   * Gates fatal handling: the classifier reads any `SomeError: …` leaf line as
   * engine death, which is right during startup and wrong afterwards. A
   * caught, contained Python exception prints the same shape as a fatal one,
   * and killing the engine for it takes down every *other* session sharing it
   * — a spec-decode wave that failed one request, and answered that request,
   * SIGKILLed a 27B mid-turn and dropped an unrelated session with it.
   */
  private serving = false;
  /**
   * Most recent error line seen while serving. Not fatal — kept so a turn that
   * dies on a dropped stream can name the real cause instead of "something
   * closed the HTTP request."
   */
  private lastRuntimeError: MlxFatalError | null = null;

  constructor(private readonly deps: EngineLogRouterDeps) {}

  /** One raw line from the supervised child. */
  onLine(line: string): void {
    // Fatal takes precedence over phase classification — one `ValueError: …`
    // leaf line in a traceback is enough to mark the engine broken, and
    // surfacing it immediately beats hanging for the full turn-timeout.
    // Only before the engine is serving, though: once it is up, the same line
    // shape carries *contained* per-request failures the sidecar has already
    // handled and answered.
    const fatal = classifyMlxFatalErrorLine(line);
    if (fatal) {
      if (this.serving) this.noteRuntimeError(fatal);
      else this.handleFatalError(fatal);
      return;
    }
    const phase = classifyMlxStartupLine(line);
    if (!phase) return;
    const name = this.deps.modelDisplayName?.();
    if (phase.phase === 'loading_model' && name) {
      phase.detail = `Loading model — ${name}`;
    }
    // A fresh child gets a clean slate. Both flags move before the repeat
    // filter below: an identical phase line returns early, and readiness must
    // not depend on which line won.
    if (phase.phase === 'starting') {
      this.fatalError = null;
      this.lastRuntimeError = null;
      this.serving = false;
    }
    if (phase.phase === 'ready') this.serving = true;
    if (
      this.lastStartupPhase &&
      this.lastStartupPhase.phase === phase.phase &&
      this.lastStartupPhase.detail === phase.detail &&
      // Two subs prefilling in lockstep render identical detail; without the
      // owner in the key the second one's marker is dropped as a repeat and
      // that session's bar stalls at whatever it last saw.
      this.lastStartupPhase.cacheId === phase.cacheId
    ) {
      return;
    }
    this.lastStartupPhase = phase.phase === 'ready' ? null : phase;
    this.deps.deliver(phase);
    if (phase.phase === 'ready') this.deps.onReady();
  }

  /**
   * Last delivered phase, replayed to a session that registers mid-run so a
   * chat opened during a long weight load still shows what the engine is
   * doing. Null once `ready` clears it — there is nothing to catch up on.
   */
  lastPhase(): EnginePhaseEvent | null {
    return this.lastStartupPhase;
  }

  /**
   * Consume the startup fatal, if one was seen. Consumes on read: the caller
   * still throws it, so the *current* send fails fast, but a later send gets a
   * fresh shot at respawning — otherwise a fix made out-of-process
   * (reinstalled deps, a different model, a venv reset) would not take effect
   * until gezeld itself restarted.
   */
  takeFatalError(): MlxFatalError | null {
    const fatal = this.fatalError;
    this.fatalError = null;
    return fatal;
  }

  /** Consume the last serving-time error, if one was seen. */
  takeRuntimeError(): MlxFatalError | null {
    const err = this.lastRuntimeError;
    this.lastRuntimeError = null;
    return err;
  }

  /**
   * An error from an engine that is up and serving. Deliberately does NOT tear
   * the engine down: the sidecar prints these from handlers that already
   * contained the failure and answered the affected request, so the engine is
   * still correct for everyone else on it.
   */
  private noteRuntimeError(fatal: MlxFatalError): void {
    this.lastRuntimeError = fatal;
    log.warn(`engine error while serving (engine left running): ${fatal.message}`);
  }

  private handleFatalError(fatal: MlxFatalError): void {
    // First-seen wins — later traceback frames must not overwrite the leaf
    // exception with something further up the stack, and a server spamming
    // the same error must not thrash the supervisor.
    if (this.fatalError) return;
    this.fatalError = fatal;
    log.error(`fatal engine error detected: ${fatal.message}`);
    this.deps.onFatal(fatal);
  }
}
