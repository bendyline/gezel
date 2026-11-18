/**
 * The runner's wire protocol. The service writes one `RunJob` to stdin and
 * reads `out/result.json` (and `out/items.ndjson`) from the run's working
 * folder; stdout is left to the component, which may print anything.
 *
 * The service keeps its own copy of these shapes (it never imports this
 * package); the spawn tests on both sides hold them together.
 */

export type RunOp = 'ping' | 'describe' | 'call' | 'poll' | 'list';

export interface ComponentRef {
  /** The installed package folder (holds `package.json`). */
  dir: string;
  /** Entry file, relative to `dir`. */
  entry: string;
  /** SHA-256 (hex) of the entry file; checked before it is loaded. */
  entrySha256: string;
}

export interface RecordedExchange {
  request: { method?: string; url: string };
  response: { status?: number; headers?: Record<string, string>; body?: unknown };
}

export interface RunLimits {
  /** Trigger performs or action pages per run (default 200). */
  maxPages?: number;
  /** Items written per run (default 10,000). */
  maxItems?: number;
  /** Bytes of `items.ndjson` per run (default 64 MiB). */
  maxBytes?: number;
  /** Stop starting new pages after this many ms (default 4 minutes). */
  budgetMs?: number;
}

export interface RunJob {
  v: 2;
  op: RunOp;
  component?: ComponentRef;
  /** Action key (`call`, `list`) or trigger key (`poll`). */
  key?: string;
  /** The Spectral connection value, passed as input `input`. */
  connection?: { input: string; value: unknown };
  inputs?: Record<string, unknown>;
  /** Where items are in each result: JSON paths, or the trigger's own resolver. */
  items?: { paths?: string[]; resolver?: boolean };
  /** `poll`: the polling state the last completed drain left. */
  state?: unknown;
  /** `poll`: the pagination state of a drain a previous run stopped short. */
  resume?: unknown;
  /** `list`: the input that takes a page token, and where the next token is. */
  page?: { input: string; from: string; token?: unknown };
  /** Hosts the component may reach. Empty or absent: none. */
  origins?: string[];
  /** Answer HTTP from these recordings, in order, and open no socket. */
  replay?: RecordedExchange[];
  limits?: RunLimits;
}

export type FailureKind =
  | 'throttled'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'upstream'
  | 'network'
  | 'origin'
  | 'replay-miss'
  | 'input'
  | 'component';

export interface RunFailure {
  kind: FailureKind;
  message: string;
  status?: number;
  retryAfterMs?: number;
}

export interface ComponentDescription {
  key?: string;
  label?: string;
  description?: string;
  actions: Record<string, EntityDescription>;
  triggers: Record<string, EntityDescription & { polling: boolean; batchSize?: number }>;
  connections: ConnectionDescription[];
  dataSources: string[];
}

export interface EntityDescription {
  label?: string;
  description?: string;
  inputs: Record<string, InputDescription>;
}

export interface InputDescription {
  type?: string;
  label?: string;
  required?: boolean;
  default?: unknown;
  collection?: string;
  comments?: string;
  shown?: boolean;
}

export interface ConnectionDescription {
  key: string;
  label?: string;
  oauth2Type?: string;
  inputs: Record<string, InputDescription>;
}

export type RunResult = RunOutcome & {
  /** Replay mode: which recordings (indices into `job.replay`) were used. */
  replayed?: number[];
};

export type RunOutcome =
  | { ok: true; op: 'ping'; sdk: string; node: string }
  | { ok: true; op: 'describe'; component: ComponentDescription }
  | { ok: true; op: 'call'; data: unknown; logs: string[] }
  | {
      ok: true;
      op: 'poll';
      items: number;
      pages: number;
      /** The drain finished: `state` is the state the next drain starts from. */
      drained: boolean;
      state: unknown;
      /** Present when `drained` is false: where the next run continues. */
      resume?: unknown;
      /** Why the drain stopped short. */
      stoppedBy?: 'pages' | 'items' | 'bytes' | 'budget';
      logs: string[];
    }
  | {
      ok: true;
      op: 'list';
      items: number;
      pages: number;
      complete: boolean;
      stoppedBy?: 'pages' | 'items' | 'bytes' | 'budget';
      logs: string[];
    }
  | { ok: false; op: RunOp; error: RunFailure; logs: string[] };
