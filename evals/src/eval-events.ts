import { EVAL_EVENT_LINE_PREFIX, type EvalHarnessEvent } from '@bendyline/gezel/eval';

/**
 * The `--events` progress channel: one `[eval-event] {json}` line per event
 * on stdout, parsed by the daemon's in-app runner with the same schema
 * (`EvalHarnessEventSchema`). The human log is untouched, so a person
 * reading a terminal sees a few extra lines and nothing else changes.
 */
export interface EvalEventSink {
  emit(event: EvalHarnessEvent): void;
  /** Next 1-based trial position across the whole matrix. */
  nextTrialIndex(): number;
  /** Planned trials, once the matrix has announced its plan. */
  totalTrials(): number;
  setTotalTrials(total: number): void;
}

export function createEvalEventSink(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): EvalEventSink {
  let index = 0;
  let total = 0;
  return {
    emit(event) {
      write(`${EVAL_EVENT_LINE_PREFIX}${JSON.stringify(event)}`);
    },
    nextTrialIndex() {
      index += 1;
      return index;
    },
    totalTrials: () => total,
    setTotalTrials(next) {
      total = next;
    },
  };
}
