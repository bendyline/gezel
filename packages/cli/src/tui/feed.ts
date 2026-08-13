import type {
  ChatEventEnvelope,
  ChatSession,
  GezelSummary,
  TerminalMessage,
} from '@bendyline/gezel';

/**
 * A single rendered line in the live chat feed. `assistant` rows stay
 * `open` while their turn streams, so successive `delta` events append to
 * the same row instead of spawning new ones.
 */
export interface FeedRow {
  key: string;
  sessionId: string;
  gezelId: string;
  kind: 'user' | 'pending' | 'assistant' | 'tool' | 'note' | 'error' | 'shell';
  text: string;
  open: boolean;
}

const MAX_ROWS = 200;

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `r${counter}`;
}

/**
 * Fold one chat-event envelope into the feed. Pure: returns a new array.
 * Deltas coalesce into the session's open assistant row; `complete` closes
 * it with the final text; `done`/`error` close any stragglers.
 */
export function reduceFeed(rows: FeedRow[], env: ChatEventEnvelope): FeedRow[] {
  const { sessionId, gezelId, event } = env;
  const cap = (next: FeedRow[]): FeedRow[] =>
    next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;

  switch (event.type) {
    case 'user_message':
      return cap([
        ...rows,
        {
          key: nextKey(),
          sessionId,
          gezelId,
          kind: 'user',
          text: event.message.content,
          open: false,
        },
      ]);

    case 'queue_enqueued': {
      const key = `queue-${event.queueId}`;
      const pending: FeedRow = {
        key,
        sessionId,
        gezelId,
        kind: 'pending',
        text: event.preview,
        open: false,
      };
      const idx = rows.findIndex((row) => row.key === key);
      if (idx === -1) return cap([...rows, pending]);
      const next = rows.slice();
      next[idx] = pending;
      return next;
    }

    case 'queue_removed':
      return rows.filter((row) => row.key !== `queue-${event.queueId}`);

    case 'delta': {
      const idx = findOpenAssistant(rows, sessionId);
      const open = idx === -1 ? undefined : rows[idx];
      if (!open) {
        return cap([
          ...rows,
          {
            key: nextKey(),
            sessionId,
            gezelId,
            kind: 'assistant',
            text: event.content,
            open: true,
          },
        ]);
      }
      const next = rows.slice();
      next[idx] = { ...open, text: open.text + event.content };
      return next;
    }

    case 'complete': {
      const idx = findOpenAssistant(rows, sessionId);
      const open = idx === -1 ? undefined : rows[idx];
      const text = event.message.content;
      if (!open) {
        return cap([
          ...rows,
          { key: nextKey(), sessionId, gezelId, kind: 'assistant', text, open: false },
        ]);
      }
      const next = rows.slice();
      next[idx] = { ...open, text: text || open.text, open: false };
      return next;
    }

    case 'tool':
      return cap([
        ...rows,
        {
          key: nextKey(),
          sessionId,
          gezelId,
          kind: 'tool',
          text: toolLabel(event),
          open: false,
        },
      ]);

    case 'awaiting_gezel':
      return cap([
        ...rows,
        {
          key: nextKey(),
          sessionId,
          gezelId,
          kind: 'note',
          text: '⏳ awaiting another gezel…',
          open: false,
        },
      ]);

    case 'task_event':
      return cap([
        ...rows,
        {
          key: nextKey(),
          sessionId: 'local',
          gezelId: '',
          kind: 'note',
          text: `task · ${event.summary}`,
          open: false,
        },
      ]);

    case 'error':
      return cap([
        ...rows,
        { key: nextKey(), sessionId, gezelId, kind: 'error', text: event.error, open: false },
      ]);

    case 'done':
      return rows.map((r) => (r.sessionId === sessionId && r.open ? { ...r, open: false } : r));

    default:
      return rows;
  }
}

/**
 * Turn a persisted session into the same compact rows used by the live feed.
 * This is what makes `/thread` a real context switch rather than merely
 * redirecting the next send to an invisible transcript.
 */
export function sessionToFeedRows(
  session: Pick<ChatSession, 'id' | 'gezelId' | 'messages' | 'lastTurnError'>,
): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const message of session.messages) {
    if (message.hidden) continue;
    if (message.role === 'assistant') {
      for (const tool of message.toolCalls ?? []) {
        rows.push({
          key: nextKey(),
          sessionId: session.id,
          gezelId: session.gezelId,
          kind: 'tool',
          text: toolRowText(tool),
          open: false,
        });
      }
    }
    if (!message.content.trim()) continue;
    rows.push({
      key: nextKey(),
      sessionId: session.id,
      gezelId: message.from?.gezelId ?? session.gezelId,
      kind:
        message.role === 'user' && !message.from
          ? 'user'
          : message.from
            ? 'assistant'
            : message.role,
      text: message.content,
      open: false,
    });
  }
  if (session.lastTurnError) {
    rows.push({
      key: nextKey(),
      sessionId: session.id,
      gezelId: session.gezelId,
      kind: 'error',
      text: session.lastTurnError,
      open: false,
    });
  }
  return rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
}

/**
 * Per-session "turn in progress" status, keyed by sessionId. Drives the
 * working indicator + status label between a send and the first token —
 * the window where a local engine is queued or loading its model and the
 * feed would otherwise look frozen.
 */
export type TurnMap = Map<string, string>;

export function reduceTurns(turns: TurnMap, env: ChatEventEnvelope): TurnMap {
  const { sessionId, event } = env;
  const set = (label: string): TurnMap => new Map(turns).set(sessionId, label);
  const clear = (): TurnMap => {
    if (!turns.has(sessionId)) return turns;
    const m = new Map(turns);
    m.delete(sessionId);
    return m;
  };
  switch (event.type) {
    case 'user_message':
      return set('thinking…');
    case 'queued':
      return set(event.aheadOf > 0 ? `queued · ${event.aheadOf} ahead` : 'queued');
    case 'intent':
      return set(event.label);
    case 'engine_phase':
      return set(phaseLabel(event));
    case 'delta':
      return set('generating');
    case 'tool':
      return set('running tool');
    case 'awaiting_gezel':
      return set('awaiting gezel');
    case 'error':
    case 'done':
      return clear();
    default:
      return turns;
  }
}

function phaseLabel(event: Extract<ChatEventEnvelope['event'], { type: 'engine_phase' }>): string {
  const pct = event.progress !== undefined ? ` ${Math.round(event.progress * 100)}%` : '';
  switch (event.phase) {
    case 'starting':
      return 'starting engine';
    case 'loading_model':
      return `loading model${pct}`;
    case 'prefill':
      return `reading prompt${pct}`;
    case 'generating':
      return 'generating';
    default:
      return 'ready';
  }
}

/** Append a local system/tool/error note (not tied to a chat session). */
export function appendNote(
  rows: FeedRow[],
  text: string,
  kind: FeedRow['kind'] = 'note',
): FeedRow[] {
  const next = [
    ...rows,
    { key: nextKey(), sessionId: 'local', gezelId: '', kind, text, open: false },
  ];
  return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
}

/**
 * Close out a terminal run when its final `message` arrives. Marks the
 * streamed row done and appends an exit/duration footer. If no chunks ever
 * streamed (an instant command), renders the canonical output now.
 */
export function finalizeShellRun(
  rows: FeedRow[],
  runId: string,
  message: TerminalMessage,
): FeedRow[] {
  const key = `term-${runId}`;
  const footer = shellFooter(message);
  const idx = rows.findIndex((r) => r.key === key);
  if (idx === -1) {
    const text = (message.content ?? '').replace(/\s+$/, '');
    const next = [
      ...rows,
      {
        key,
        sessionId: `term-${runId}`,
        gezelId: '',
        kind: 'shell' as const,
        text: text ? `${text}${footer}` : footer.trimStart(),
        open: false,
      },
    ];
    return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
  }
  const row = rows[idx];
  if (!row) return rows;
  const next = rows.slice();
  next[idx] = { ...row, open: false, text: `${row.text.replace(/\s+$/, '')}${footer}` };
  return next;
}

function shellFooter(message: TerminalMessage): string {
  if (message.errorMessage) return `\n[error: ${message.errorMessage}]`;
  const dur = message.durationMs != null ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : '';
  if (message.exitCode == null) return `\n[done${dur}]`;
  return `\n[exit ${message.exitCode}${dur}]`;
}

/** Accumulate a terminal run's output chunks into a single growing row. */
export function appendShellChunk(rows: FeedRow[], runId: string, chunk: string): FeedRow[] {
  const key = `term-${runId}`;
  const idx = rows.findIndex((r) => r.key === key);
  if (idx === -1) {
    const next = [
      ...rows,
      {
        key,
        sessionId: `term-${runId}`,
        gezelId: '',
        kind: 'shell' as const,
        text: chunk,
        open: true,
      },
    ];
    return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
  }
  const row = rows[idx];
  if (!row) return rows;
  const next = rows.slice();
  next[idx] = { ...row, text: row.text + chunk };
  return next;
}

function findOpenAssistant(rows: FeedRow[], sessionId: string): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.sessionId === sessionId && r.kind === 'assistant' && r.open) return i;
  }
  return -1;
}

function toolLabel(event: Extract<ChatEventEnvelope['event'], { type: 'tool' }>): string {
  return toolRowText(event);
}

const MAX_TOOL_DETAIL_CHARS = 160;

/**
 * One feed line per tool call: `🔧 name · detail`. Detail prefers the
 * server-built `argsSummary` (a compact human one-liner — "Read
 * docs/plan.md", `url: "https://…"`) and falls back to the touched
 * `path`; failures append the error so a red-flag run is visible without
 * expanding anything.
 */
function toolRowText(call: {
  name?: string;
  argsSummary?: string;
  path?: string;
  success?: boolean;
  errorMessage?: string;
}): string {
  const name = typeof call.name === 'string' && call.name.length > 0 ? call.name : 'tool';
  const detail = call.argsSummary ?? call.path;
  const flat = detail?.replace(/\s+/g, ' ').trim();
  const clipped =
    flat && flat.length > MAX_TOOL_DETAIL_CHARS
      ? `${flat.slice(0, MAX_TOOL_DETAIL_CHARS - 1)}…`
      : flat;
  const failed =
    call.success === false ? ` · failed${call.errorMessage ? `: ${call.errorMessage}` : ''}` : '';
  return `🔧 ${name}${clipped ? ` · ${clipped}` : ''}${failed}`;
}

/**
 * Display label for a gezel. In boring mode this uses the role-based name
 * only, never the friendly name. Falls back to the raw id when the gezel
 * isn't in the roster snapshot.
 */
export function gezelLabel(
  gezelId: string,
  gezels: ReadonlyArray<GezelSummary>,
  boring: boolean,
): string {
  const g = gezels.find((x) => x.id === gezelId);
  if (!g) return gezelId;
  if (boring) return g.roleBasedName ?? g.role ?? g.id;
  return g.role ? `${g.name} · ${g.role}` : g.name;
}
