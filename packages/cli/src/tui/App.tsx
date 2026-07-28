import type { GezelSummary } from '@bendyline/gezel';
import type { ConfigResponse, GezelClient } from '@bendyline/gezel-client/node';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SLASH_COMMAND_WORDWHEEL_SIZE, parseInput, suggestSlashCommands } from './commands.js';
import { ChatFeed } from './components/ChatFeed.js';
import { Picker, type PickerItem } from './components/Picker.js';
import { PromptLine } from './components/PromptLine.js';
import {
  type FeedRow,
  type TurnMap,
  appendNote,
  appendShellChunk,
  finalizeShellRun,
  reduceFeed,
  reduceTurns,
} from './feed.js';
import { useProjectEvents, useTerminalEvents } from './streams.js';

interface PendingInput {
  runId: string;
  mode: 'text' | 'password' | 'yes-no';
  promptLine: string;
}

/** Terminal height, kept live across resizes — drives how many feed rows fit. */
function useTerminalRows(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout?.rows ?? 24);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setRows(stdout.rows ?? 24);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return rows;
}

type Overlay = null | 'project' | 'gezel' | 'task' | 'focus';
interface ProjectRow {
  id: string;
  name: string;
  workingDir?: string;
}
interface TaskRow {
  ref: string;
  title: string;
  status: string;
}

const HELP = [
  '/project — switch project   /gezel — switch gezel   /task — set active task',
  '/focus — send into another active chat   /cli — CLI mode   /chat — chat mode',
  '!cmd — run shell   @tools — list tools   @tool <name> {json} — run a tool',
  '/clear — clear feed   /quit — exit',
  '↑/↓ — input history   Esc — interrupt turn   Ctrl+C — interrupt, then again to exit',
];

export function App(props: {
  client: GezelClient;
  initialProjectId: string;
  initialProjectName: string;
  /** Role-based labels are the compact TUI default. */
  boring?: boolean;
}): JSX.Element {
  const { client } = props;
  const { exit } = useApp();

  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);

  const [projectId, setProjectId] = useState(props.initialProjectId);
  const [projectName, setProjectName] = useState(props.initialProjectName);
  const [activeGezelId, setActiveGezelId] = useState<string | null>(null);
  const [ownSessionId, setOwnSessionId] = useState<string | null>(null);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);

  const [mode, setMode] = useState<'chat' | 'cli'>('chat');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [value, setValue] = useState('');
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [turns, setTurns] = useState<TurnMap>(() => new Map());
  const [status, setStatus] = useState<string | null>('Connecting…');
  const [history, setHistory] = useState<string[]>([]);
  const [activeRuns, setActiveRuns] = useState<Set<string>>(() => new Set());
  const [pendingInput, setPendingInput] = useState<PendingInput | null>(null);
  const [selectedTaskRef, setSelectedTaskRef] = useState<string | null>(null);
  const [exitArmed, setExitArmed] = useState(false);
  const termRows = useTerminalRows();
  const wordwheelCount = overlay === null && !pendingInput ? suggestSlashCommands(value).length : 0;
  const wordwheelRows =
    wordwheelCount > 0 ? Math.min(SLASH_COMMAND_WORDWHEEL_SIZE, wordwheelCount) + 1 : 0;
  const visibleRows = Math.max(4, termRows - 7 - wordwheelRows);

  // Keep terminal labels compact and task-oriented regardless of the desktop
  // UI preference. The TUI defaults to role-based names without mutating the
  // shared boring-mode setting.
  const boring = props.boring ?? true;
  const busy = turns.size > 0;
  const statusLabel = useMemo(() => {
    if (turns.size === 0) return undefined;
    return (
      (focusedSessionId && turns.get(focusedSessionId)) ||
      (ownSessionId && turns.get(ownSessionId)) ||
      turns.values().next().value
    );
  }, [turns, focusedSessionId, ownSessionId]);
  const note = useCallback(
    (text: string, kind: FeedRow['kind'] = 'note') => setRows((r) => appendNote(r, text, kind)),
    [],
  );

  // Live feeds for the whole project (chat across all gezels + terminal).
  useProjectEvents(
    client,
    projectId,
    useCallback((env) => {
      setRows((r) => reduceFeed(r, env));
      setTurns((t) => reduceTurns(t, env));
    }, []),
  );
  useTerminalEvents(
    client,
    projectId,
    useCallback((env) => {
      switch (env.kind) {
        case 'runStarted':
          setActiveRuns((s) => new Set(s).add(env.runId));
          return;
        case 'outputChunk':
          setRows((r) => appendShellChunk(r, env.runId, env.chunk));
          return;
        case 'inputRequested':
          setPendingInput({ runId: env.runId, mode: env.mode, promptLine: env.promptLine });
          setRows((r) => appendNote(r, `⌨ waiting for input — ${env.promptLine}`, 'note'));
          return;
        case 'message': {
          const runId = env.runId;
          if (!runId) return;
          setActiveRuns((s) => {
            if (!s.has(runId)) return s;
            const n = new Set(s);
            n.delete(runId);
            return n;
          });
          setPendingInput((p) => (p?.runId === runId ? null : p));
          setRows((r) => finalizeShellRun(r, runId, env.message));
          return;
        }
        default:
          return;
      }
    }, []),
  );

  // Create (or recreate) the user's own session for the active gezel +
  // project. Sets it as the focus target for new input.
  const ensureSession = useCallback(
    async (gezelId: string, pid: string) => {
      try {
        const session = await client.createChatSession({ gezelId, projectId: pid });
        setOwnSessionId(session.id);
        setFocusedSessionId(session.id);
      } catch (err) {
        note(`could not start a session: ${errMsg(err)}`, 'error');
      }
    },
    [client, note],
  );

  // Initial load. Mount-only — project/gezel switches are driven by their
  // pickers, which call ensureSession directly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfg, gz, pj] = await Promise.all([
          client.getConfig(),
          client.listGezels(),
          client.listProjects(),
        ]);
        if (cancelled) return;
        setConfig(cfg);
        setGezels(gz.gezels);
        setProjects(pj.projects.map((p) => ({ id: p.id, name: p.name, workingDir: p.workingDir })));
        const gezelId = cfg.meesterGezelId ?? gz.gezels[0]?.id ?? null;
        setActiveGezelId(gezelId);
        setStatus(null);
        if (gezelId) await ensureSession(gezelId, projectId);
        else note('no gezels available — create one with `gezel agent create`.', 'error');
      } catch (err) {
        if (!cancelled) setStatus(`Failed to connect: ${errMsg(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh tasks for the active project. Deliberately NOT polling
  // /api/config here: that endpoint reads provider credentials from the
  // OS keychain, which (under a bare `node` dev run) re-prompts on every
  // read. Provider is read once in the initial load; it rarely changes
  // mid-session. `listTasks` only touches task files.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await client.listTasks();
        if (cancelled) return;
        setTasks(
          res.tasks
            .filter((t) => t.ref.startsWith(`${projectId}/`))
            .map((t) => ({ ref: t.ref, title: t.title, status: t.status })),
        );
      } catch {
        /* leave prior tasks */
      }
    };
    load();
    const id = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client, projectId]);

  const activeTaskRef = useMemo(() => {
    // User's explicit `/task` pick wins; otherwise fall back to the first
    // active task for the project as the ambient "active task".
    if (selectedTaskRef && tasks.some((t) => t.ref === selectedTaskRef)) return selectedTaskRef;
    return tasks.find((t) => t.status === 'active')?.ref;
  }, [tasks, selectedTaskRef]);

  const gezelLine = useMemo(() => {
    const g = gezels.find((x) => x.id === activeGezelId);
    if (!g) return '…';
    if (boring) return g.roleBasedName ?? g.role ?? g.id;
    return g.role ? `${g.name} · ${g.role}` : g.name;
  }, [gezels, activeGezelId, boring]);

  // Distinct active chat sessions seen in the feed — targets for /focus.
  const focusItems = useMemo<PickerItem[]>(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.sessionId === 'local' || r.sessionId.startsWith('term-')) continue;
      if (!seen.has(r.sessionId)) {
        const label = gezels.find((g) => g.id === r.gezelId)?.name ?? (r.gezelId || r.sessionId);
        seen.set(r.sessionId, label);
      }
    }
    const items: PickerItem[] = [];
    if (ownSessionId) items.push({ label: 'your session', value: ownSessionId, hint: gezelLine });
    for (const [sid, label] of seen) {
      if (sid === ownSessionId) continue;
      items.push({ label, value: sid });
    }
    return items;
  }, [rows, gezels, ownSessionId, gezelLine]);

  // Cancel everything in flight: open chat turns + running shell commands.
  const cancelActive = useCallback(async () => {
    const sessions = [...turns.keys()];
    const runs = [...activeRuns];
    if (sessions.length === 0 && runs.length === 0) return false;
    await Promise.allSettled([
      ...sessions.map((s) => client.cancelChatSessionTurn(s)),
      ...runs.map((r) => client.cancelTerminalRun(projectId, r)),
    ]);
    return true;
  }, [turns, activeRuns, client, projectId]);

  const runInput = useCallback(
    async (raw: string) => {
      // A shell run is waiting on stdin — route this line straight to it
      // (raw, so passwords/whitespace pass through verbatim).
      if (pendingInput) {
        const target = pendingInput;
        setPendingInput(null);
        try {
          await client.sendTerminalInput(projectId, target.runId, raw);
        } catch (err) {
          note(`input failed: ${errMsg(err)}`, 'error');
        }
        return;
      }
      const parsed = parseInput(raw, mode === 'cli');
      switch (parsed.kind) {
        case 'empty':
          return;
        case 'command':
          await runCommand(parsed.name, parsed.rest);
          return;
        case 'prompt': {
          const target = focusedSessionId ?? ownSessionId;
          if (!target) return note('no active session yet.', 'error');
          try {
            await client.sendToChatSession(target, parsed.text);
          } catch (err) {
            note(`send failed: ${errMsg(err)}`, 'error');
          }
          return;
        }
        case 'shell': {
          if (!parsed.text) return;
          note(`$ ${parsed.text}`);
          try {
            await client.runTerminalCommand(projectId, { workingDir: '', input: parsed.text });
          } catch (err) {
            note(`shell failed: ${errMsg(err)}`, 'error');
          }
          return;
        }
        case 'tools': {
          const target = focusedSessionId ?? ownSessionId;
          if (!target) return note('no active session yet.', 'error');
          try {
            const res = await client.listSessionTools(target);
            note(`tools (${res.tools.length}): ${res.tools.map((t) => t.name).join(', ')}`, 'tool');
          } catch (err) {
            note(`list tools failed: ${errMsg(err)}`, 'error');
          }
          return;
        }
        case 'tool': {
          const target = focusedSessionId ?? ownSessionId;
          if (!target) return note('no active session yet.', 'error');
          let args: Record<string, unknown> = {};
          if (parsed.argsJson) {
            try {
              args = JSON.parse(parsed.argsJson) as Record<string, unknown>;
            } catch {
              return note(`invalid JSON args for @tool ${parsed.name}`, 'error');
            }
          }
          note(`@tool ${parsed.name} ${parsed.argsJson}`.trim(), 'tool');
          try {
            const res = await client.invokeSessionTool(target, parsed.name, args);
            note(res.text || '(no output)', 'tool');
          } catch (err) {
            note(`tool failed: ${errMsg(err)}`, 'error');
          }
          return;
        }
      }
    },
    [client, mode, projectId, focusedSessionId, ownSessionId, note, pendingInput],
  );

  const runCommand = useCallback(
    async (name: string, _rest: string) => {
      switch (name) {
        case 'help':
        case '?':
          for (const line of HELP) note(line);
          return;
        case 'project':
          return setOverlay('project');
        case 'gezel':
          return setOverlay('gezel');
        case 'task':
          return setOverlay('task');
        case 'focus':
          return setOverlay('focus');
        case 'cli':
          setMode('cli');
          return note('CLI mode — bare input runs as a shell command. /chat to exit.');
        case 'chat':
          setMode('chat');
          return note('chat mode — bare input is a prompt to your gezel.');
        case 'clear':
          setTurns(new Map());
          setPendingInput(null);
          return setRows([]);
        case 'quit':
        case 'exit':
          exit();
          return;
        default:
          return note(`unknown command: /${name} (try /help)`, 'error');
      }
    },
    [note, exit],
  );

  const onSubmit = useCallback(
    (raw: string) => {
      setValue('');
      // Record real submissions for ↑/↓ recall — but never stdin answers
      // (which may be passwords) and never bare blanks.
      const trimmed = raw.trim();
      if (trimmed && !pendingInput) {
        setHistory((h) => (h[h.length - 1] === trimmed ? h : [...h, trimmed].slice(-100)));
      }
      void runInput(raw);
    },
    [runInput, pendingInput],
  );

  // Esc / Ctrl+C interrupt in-flight work; a second Ctrl+C on an idle prompt
  // exits. Esc with nothing running just re-homes focus to your own session.
  const cancelActiveRef = useRef(cancelActive);
  cancelActiveRef.current = cancelActive;
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        if (turns.size > 0 || activeRuns.size > 0) {
          void cancelActiveRef.current().then((did) => did && note('interrupted.'));
          return;
        }
        if (value) return setValue('');
        if (exitArmed) return exit();
        setExitArmed(true);
        note('press Ctrl+C again to exit.');
        setTimeout(() => setExitArmed(false), 1500);
        return;
      }
      if (key.escape) {
        if (turns.size > 0 || activeRuns.size > 0) {
          void cancelActiveRef.current().then((did) => did && note('interrupted.'));
        } else if (pendingInput) {
          setPendingInput(null);
        } else if (ownSessionId) {
          setFocusedSessionId(ownSessionId);
        }
      }
    },
    { isActive: overlay === null },
  );

  if (status) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={status.startsWith('Failed') ? 'red' : 'cyan'}>{status}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <ChatFeed
        rows={rows}
        gezels={gezels}
        boring={boring}
        focusedSessionId={focusedSessionId ?? undefined}
        visible={visibleRows}
      />
      {overlay === 'project' ? (
        <Picker
          title="Switch project"
          items={projects.map((p) => ({ label: p.name, value: p.id, hint: p.workingDir }))}
          onCancel={() => setOverlay(null)}
          onSelect={(id) => {
            setOverlay(null);
            const p = projects.find((x) => x.id === id);
            if (!p || id === projectId) return;
            setProjectId(id);
            setProjectName(p.name);
            setRows([]);
            setTurns(new Map());
            setActiveRuns(new Set());
            setPendingInput(null);
            setSelectedTaskRef(null);
            if (activeGezelId) void ensureSession(activeGezelId, id);
          }}
        />
      ) : null}
      {overlay === 'gezel' ? (
        <Picker
          title="Switch gezel"
          items={gezels.map((g) => ({
            label: boring ? (g.roleBasedName ?? g.role ?? g.id) : g.name,
            value: g.id,
            hint: g.role,
          }))}
          onCancel={() => setOverlay(null)}
          onSelect={(id) => {
            setOverlay(null);
            if (id === activeGezelId) return;
            setActiveGezelId(id);
            void ensureSession(id, projectId);
          }}
        />
      ) : null}
      {overlay === 'task' ? (
        <Picker
          title="Active task"
          items={[
            { label: '(none)', value: '' },
            ...tasks.map((t) => ({ label: t.ref, value: t.ref, hint: t.title })),
          ]}
          onCancel={() => setOverlay(null)}
          onSelect={(ref) => {
            setOverlay(null);
            setSelectedTaskRef(ref || null);
            note(ref ? `active task → ${ref}` : 'active task cleared.');
          }}
        />
      ) : null}
      {overlay === 'focus' ? (
        <Picker
          title="Send into which chat?"
          items={focusItems}
          onCancel={() => setOverlay(null)}
          onSelect={(sid) => {
            setOverlay(null);
            setFocusedSessionId(sid);
          }}
        />
      ) : null}
      <PromptLine
        projectName={projectName}
        gezelLabel={gezelLine}
        taskRef={activeTaskRef}
        mode={mode}
        provider={config?.provider}
        busy={busy}
        statusLabel={statusLabel}
        value={value}
        active={overlay === null}
        history={history}
        pendingPrompt={pendingInput?.promptLine}
        pendingMode={pendingInput?.mode}
        onChange={setValue}
        onSubmit={onSubmit}
      />
    </Box>
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
