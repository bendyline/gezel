/**
 * What the engine is doing before a reply, on stderr. A first MLX turn
 * installs its Python environment (torch, transformers, scipy), and `gezel run`
 * printed nothing for about five minutes while it did (2026-10-13 npm audit).
 *
 * Each kind of wait is reported once, and only after it has lasted a moment, so
 * a warm engine adds nothing to the output. A `prefill` heartbeat (MLX sends
 * one every 4 s from the start of a turn) never displaces a pending setup line.
 */

export interface RunPhaseEvent {
  provider: string;
  phase: string;
  detail?: string;
}

const ENGINE_NAMES: Record<string, string> = {
  mlx: 'MLX',
  'llama-cpp': 'llama.cpp',
  ds4: 'DS4',
};

/** How much a wait says: setup outranks prompt processing. */
const WAIT_RANK: Record<string, number> = { starting: 2, loading_model: 2, prefill: 1 };

const DEFAULT_DETAIL: Record<string, string> = {
  starting: 'starting the engine',
  loading_model: 'loading the model',
  prefill: 'reading the prompt',
};

/** The line for a wait before the reply, or undefined once the engine is answering. */
export function phaseLine(event: RunPhaseEvent): string | undefined {
  if (WAIT_RANK[event.phase] === undefined) return undefined;
  const engine = ENGINE_NAMES[event.provider] ?? event.provider;
  const detail = event.detail ?? DEFAULT_DETAIL[event.phase]!;
  return detail.startsWith(engine) ? detail : `${engine}: ${detail}`;
}

export class RunProgress {
  private pending:
    | { phase: string; line: string; timer: ReturnType<typeof setTimeout> }
    | undefined;
  private readonly reported = new Set<string>();

  constructor(
    private readonly write: (text: string) => void,
    private readonly delayMs = 2_000,
  ) {}

  phase(event: RunPhaseEvent): void {
    const line = phaseLine(event);
    if (!line) {
      this.settle();
      return;
    }
    if (this.reported.has(event.phase)) return;
    if (this.pending?.phase === event.phase) {
      this.pending.line = line;
      return;
    }
    if (this.pending && WAIT_RANK[this.pending.phase]! > WAIT_RANK[event.phase]!) return;
    this.settle();
    const pending = {
      phase: event.phase,
      line,
      timer: setTimeout(() => {
        this.pending = undefined;
        this.reported.add(pending.phase);
        this.write(`${pending.line}\n`);
      }, this.delayMs),
    };
    this.pending = pending;
  }

  /** The reply started or the turn ended: nothing still waiting is worth a line. */
  settle(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }
}
