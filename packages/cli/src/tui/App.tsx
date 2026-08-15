import type {
  ChatSessionSummary,
  ClaudePermissionMode,
  CodexPermissionMode,
  GezelSummary,
  NightShiftTasksResponse,
  Project,
  Question,
  Task,
  TaskStatus,
} from '@bendyline/gezel';
import type {
  ConfigResponse,
  GezelClient,
  LlamaCppInstallEvent,
  MlxInstallEvent,
} from '@bendyline/gezel-client/node';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ensureCliProjectLead } from '../connection.js';
import {
  CLI_ENGAGEMENT_MODES,
  CLI_ENGAGEMENT_MODE_USAGE,
  cliEngagementModeOption,
  parseCliEngagementMode,
} from '../engagement-mode.js';
import { activeAccessMode } from './active-access.js';
import { useBufferedState } from './buffered-state.js';
import {
  PROJECT_PERMISSION_USAGE,
  SLASH_COMMAND_WORDWHEEL_SIZE,
  parseInput,
  parseProjectPermissionName,
  suggestSlashWordwheel,
} from './commands.js';
import { ChatFeed } from './components/ChatFeed.js';
import { Picker, type PickerItem } from './components/Picker.js';
import { PromptLine } from './components/PromptLine.js';
import {
  QUESTION_OPTION_WINDOW_SIZE,
  QuestionPrompt,
  questionOptionCount,
} from './components/QuestionPrompt.js';
import {
  type StartCraftbook,
  craftbookCategories,
  craftbookStartRequest,
  findCraftbook,
  normalizeCraftbooks,
} from './craftbook-start.js';
import {
  type FeedRow,
  type TurnMap,
  appendNote,
  appendShellChunk,
  finalizeShellRun,
  gezelLabel,
  reduceFeed,
  reduceTurns,
  sessionToFeedRows,
} from './feed.js';
import type { TuiRuntimeDiagnostics } from './memory-diagnostics.js';
import {
  type ModelChoice,
  type ModelDownloadChoice,
  loadModelChoices,
  loadModelDownloadChoices,
  modelProviderLabel,
} from './model-picker.js';
import {
  type CliOpenReference,
  cliOpenReferencesFromEvent,
  cliOpenReferencesFromSession,
  rememberCliOpenReferences,
  resolveCliOpenTarget,
} from './open-command.js';
import { pendingQuestionsForTui, updatePendingQuestion } from './question-queue.js';
import { useProjectEvents, useTerminalEvents } from './streams.js';

interface PendingInput {
  runId: string;
  mode: 'text' | 'password' | 'yes-no';
  promptLine: string;
}

/** Terminal size, kept live across resizes for feed height and shell layout. */
function useTerminalSize(): { rows: number; columns: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

type Overlay =
  | null
  | 'project'
  | 'gezel'
  | 'engagement-mode'
  | 'model'
  | 'model-download'
  | 'thread'
  | 'task'
  | 'start-category'
  | 'start-craftbook'
  | 'focus';
type TaskOverlay = 'task' | 'task-actions' | 'task-status' | 'task-assignee';
interface ProjectRow {
  id: string;
  name: string;
  workingDir?: string;
  voormanGezelId?: string;
  managedWorkspaceWritePolicy?: Project['managedWorkspaceWritePolicy'];
  /** @deprecated Compatibility with project files written before the named policy. */
  allowGezelWrites?: boolean;
  codexPermissionMode?: CodexPermissionMode;
  claudePermissionMode?: ClaudePermissionMode;
}
interface TaskTextPrompt {
  kind: 'create' | 'title' | 'description';
  promptLine: string;
  taskRef?: string;
}

interface ModelDownloadProgress {
  choice: ModelDownloadChoice;
  bytesWritten: number;
  totalBytes: number | null;
  pct: number | null;
  phase?: string;
  companion?: {
    kind: 'image-recognition';
    id: string;
    name: string;
  };
}

const HELP = [
  '/project — switch project   /gezel — switch gezel   /model — switch engine + model',
  '/model download — choose and download a new on-device model',
  '/allow edits — allow tool edits   /disallow edits — make tool edits read-only',
  '/allow codexedits|claudeedits — allow provider-native project edits',
  '/disallow codexedits|claudeedits — put that provider in read-only plan mode',
  '/show thinking — show model reasoning inline   /hide thinking — hide it',
  '/show writes — stream write contents inline   /hide writes — hide them (default)',
  '/mode — choose read-only, reactive, reactive+tasks, or full-play AI activity',
  '/thread — switch or start a chat thread',
  '/open workspace|artifacts|<recent file> — open a folder or file from chat',
  '/task — list, inspect, create, edit, assign, or change task status',
  '/do — choose a craftbook and start it as a task',
  '/continue — process due schedules and active tasks in this project',
  '/nightshift start|stop|list — manage Night Shift',
  '/focus — send into another active chat   /cli — CLI mode   /chat — chat mode',
  '!cmd — run shell   @tools — list tools   @tool <name> {json} — run a tool',
  '/clear — clear feed   /quit — exit',
  '↑/↓ — input history   Esc — interrupt turn   Ctrl+C — interrupt, then again to exit',
];

const READ_ONLY_BOOT_NOTE =
  "Note: this folder is read-only to gezel, and can be used for doing analysis and writing reports. Use the /allow edits command to permit gezel to edit this folder's contents.";

export function App(props: {
  client: GezelClient;
  initialProjectId: string;
  initialProjectName: string;
  initialGezelId: string;
  /** Role-based labels are the compact TUI default. */
  boring?: boolean;
  diagnostics?: TuiRuntimeDiagnostics;
}): JSX.Element {
  const { client } = props;
  const { exit } = useApp();

  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [threads, setThreads] = useState<ChatSessionSummary[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [craftbooks, setCraftbooks] = useState<StartCraftbook[]>([]);
  const [craftbookProjectType, setCraftbookProjectType] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [suggestedCraftbookIds, setSuggestedCraftbookIds] = useState<Set<string>>(() => new Set());
  const [craftbooksNeedingSetup, setCraftbooksNeedingSetup] = useState<Set<string>>(
    () => new Set(),
  );
  const [startCategoryId, setStartCategoryId] = useState<string | null>(null);
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>([]);
  const [modelDownloadChoices, setModelDownloadChoices] = useState<ModelDownloadChoice[]>([]);
  const [modelDownloadProgress, setModelDownloadProgress] = useState<ModelDownloadProgress | null>(
    null,
  );
  const [modelDownloadReturn, setModelDownloadReturn] = useState<'model' | null>(null);
  const [modelChoicesLoading, setModelChoicesLoading] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [pendingQuestions, setPendingQuestions] = useState<Question[]>([]);

  const [projectId, setProjectId] = useState(props.initialProjectId);
  const [projectName, setProjectName] = useState(props.initialProjectName);
  const [activeGezelId, setActiveGezelId] = useState<string | null>(null);
  const [ownSessionId, setOwnSessionId] = useState<string | null>(null);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [activeThreadTitle, setActiveThreadTitle] = useState<string | null>(null);

  const [mode, setMode] = useState<'chat' | 'cli'>('chat');
  const [overlay, setOverlay] = useState<Overlay | TaskOverlay>(null);
  const [value, setValue] = useState('');
  const [rows, setRows, setRowsBuffered] = useBufferedState<FeedRow[]>([], 50);
  const [turns, setTurns, setTurnsBuffered] = useBufferedState<TurnMap>(() => new Map(), 50);
  const [recentOpenReferences, setRecentOpenReferences] = useState<CliOpenReference[]>([]);
  const recentOpenReferencesRef = useRef<ReadonlyArray<CliOpenReference>>([]);
  const [status, setStatus] = useState<string | null>('Connecting…');
  const [history, setHistory] = useState<string[]>([]);
  const [activeRuns, setActiveRuns] = useState<Set<string>>(() => new Set());
  const [pendingInput, setPendingInput] = useState<PendingInput | null>(null);
  const [managedTaskRef, setManagedTaskRef] = useState<string | null>(null);
  const [taskPrompt, setTaskPrompt] = useState<TaskTextPrompt | null>(null);
  const [exitArmed, setExitArmed] = useState(false);
  useEffect(() => {
    props.diagnostics?.recordReactCommit();
  });
  const pendingQuestion = pendingQuestions[0];
  const { rows: termRows, columns: termColumns } = useTerminalSize();
  // The root Ink box has one cell of horizontal padding on each side.
  // Tell the PTY the remaining width so programs such as `ls` choose a
  // column layout that reaches the edge without being re-wrapped by Ink.
  const shellColumns = Math.min(500, Math.max(20, termColumns - 2));
  const wordwheelCount =
    overlay === null && !pendingInput && !pendingQuestion
      ? suggestSlashWordwheel(value, craftbooks, recentOpenReferences).length
      : 0;
  const wordwheelRows =
    wordwheelCount > 0 ? Math.min(SLASH_COMMAND_WORDWHEEL_SIZE, wordwheelCount) + 1 : 0;
  const questionRows = pendingQuestion
    ? Math.min(QUESTION_OPTION_WINDOW_SIZE, Math.max(1, questionOptionCount(pendingQuestion))) + 4
    : 0;
  const modelPickerWindowSize = Math.max(4, Math.min(10, termRows - 12));
  const inventoryPickerRows =
    overlay === 'model' ||
    overlay === 'model-download' ||
    overlay === 'start-category' ||
    overlay === 'start-craftbook'
      ? modelPickerWindowSize + 5
      : 0;
  const visibleRows = Math.max(
    4,
    termRows - 7 - wordwheelRows - questionRows - inventoryPickerRows,
  );

  // Keep terminal labels compact and task-oriented regardless of the desktop
  // UI preference. The TUI defaults to role-based names without mutating the
  // shared boring-mode setting.
  const boring = props.boring ?? true;
  const busy = turns.size > 0;
  const activeGezel = useMemo(
    () => gezels.find((gezel) => gezel.id === activeGezelId),
    [gezels, activeGezelId],
  );
  const effectiveProvider = activeGezel?.provider ?? config?.provider;
  const effectiveModel =
    activeGezel?.model ??
    (effectiveProvider ? config?.defaultModel?.[effectiveProvider] : undefined);
  const statusLabel = useMemo(() => {
    if (turns.size === 0) return undefined;
    const turn =
      (focusedSessionId && turns.get(focusedSessionId)) ||
      (ownSessionId && turns.get(ownSessionId)) ||
      turns.values().next().value;
    return turn?.label;
  }, [turns, focusedSessionId, ownSessionId]);
  const note = useCallback(
    (text: string, kind: FeedRow['kind'] = 'note') => setRows((r) => appendNote(r, text, kind)),
    [setRows],
  );
  useEffect(() => {
    recentOpenReferencesRef.current = recentOpenReferences;
  }, [recentOpenReferences]);

  // A task launch can recruit a new gezel after the TUI's initial roster
  // load. Keep ids in a ref so the project-event callback can detect that
  // actor without being recreated for every roster update, and coalesce the
  // burst of task + chat events into one refresh.
  const gezelIds = useRef<Set<string>>(new Set());
  const gezelRefreshInFlight = useRef(false);
  const applyGezelSnapshot = useCallback((next: GezelSummary[]) => {
    gezelIds.current = new Set(next.map((gezel) => gezel.id));
    setGezels(next);
  }, []);
  const refreshGezels = useCallback(async () => {
    if (gezelRefreshInFlight.current) return;
    gezelRefreshInFlight.current = true;
    try {
      const result = await client.listGezels();
      applyGezelSnapshot(result.gezels);
    } catch {
      /* retain the last good snapshot; the next unknown actor retries */
    } finally {
      gezelRefreshInFlight.current = false;
    }
  }, [applyGezelSnapshot, client]);

  const taskLoadSequence = useRef(0);
  const refreshTasks = useCallback(async () => {
    const sequence = ++taskLoadSequence.current;
    try {
      const res = await client.listProjectTasks(projectId);
      if (sequence !== taskLoadSequence.current) return;
      setTasks(sortTasks(res.tasks));
    } catch {
      /* retain the last good snapshot; the fallback poll will retry */
    }
  }, [client, projectId]);

  const craftbookLoadSequence = useRef(0);
  const refreshCraftbooks = useCallback(async (): Promise<StartCraftbook[]> => {
    const sequence = ++craftbookLoadSequence.current;
    const result = await client.listProjectCraftbooks(projectId);
    if (sequence !== craftbookLoadSequence.current) return [];
    const next = normalizeCraftbooks(result.items, config?.showWorkInProgressFeatures === true);
    setCraftbooks(next);
    setCraftbookProjectType(result.projectType ?? null);
    setSuggestedCraftbookIds(new Set(result.suggestedIds ?? []));
    setCraftbooksNeedingSetup(new Set(Object.keys(result.missingToolsets)));
    return next;
  }, [client, config?.showWorkInProgressFeatures, projectId]);

  // Live feeds for the whole project (chat across all gezels + terminal).
  useProjectEvents(
    client,
    projectId,
    useCallback(
      (env) => {
        props.diagnostics?.recordChatEvent(env);
        const streaming =
          env.event.type === 'delta' ||
          env.event.type === 'reasoning_delta' ||
          env.event.type === 'tool_args_delta';
        const updateRows = streaming ? setRowsBuffered : setRows;
        const updateTurns = streaming ? setTurnsBuffered : setTurns;
        updateRows((r) =>
          reduceFeed(r, env, {
            showThinking: config?.cliShowThinking !== false,
            showWrites: config?.cliShowWrites === true,
          }),
        );
        updateTurns((t) => reduceTurns(t, env));
        const observedReferences = cliOpenReferencesFromEvent(env);
        if (observedReferences.length > 0) {
          setRecentOpenReferences((current) =>
            rememberCliOpenReferences(current, observedReferences),
          );
        }
        const eventGezelId =
          env.gezelId || (env.event.type === 'task_event' ? env.event.gezelId : undefined);
        if (eventGezelId && !gezelIds.current.has(eventGezelId)) void refreshGezels();
        if (env.event.type === 'task_event') void refreshTasks();
        if (env.event.type === 'user_message' && env.sessionId === ownSessionId) {
          const nextTitle = env.event.message.content.slice(0, 60).trim() || 'Untitled';
          setActiveThreadTitle((current) => (current === 'New thread' ? nextTitle : current));
          setThreads((current) =>
            current.map((thread) =>
              thread.id === env.sessionId && thread.title === 'New session'
                ? { ...thread, title: nextTitle }
                : thread,
            ),
          );
        }
        if (env.event.type === 'question_asked' || env.event.type === 'question_answered') {
          const question = env.event.question;
          setPendingQuestions((questions) => updatePendingQuestion(questions, question));
        }
      },
      [
        config?.cliShowThinking,
        config?.cliShowWrites,
        ownSessionId,
        props.diagnostics,
        refreshGezels,
        refreshTasks,
        setRows,
        setRowsBuffered,
        setTurns,
        setTurnsBuffered,
      ],
    ),
  );
  useTerminalEvents(
    client,
    projectId,
    useCallback(
      (env) => {
        props.diagnostics?.recordTerminalEvent(env);
        switch (env.kind) {
          case 'runStarted':
            setActiveRuns((s) => new Set(s).add(env.runId));
            return;
          case 'outputChunk':
            setRowsBuffered((r) => appendShellChunk(r, env.runId, env.chunk));
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
      },
      [props.diagnostics, setRows, setRowsBuffered],
    ),
  );

  // Create (or recreate) the user's own session for the active gezel +
  // project. Sets it as the focus target for new input.
  const ensureSession = useCallback(
    async (gezelId: string, pid: string) => {
      try {
        // Pin the session's name-rendering mode to the TUI's: without the
        // stamp the daemon builds prompts from the desktop preference and
        // the model addresses gezels by names these labels never show.
        const session = await client.createChatSession({
          gezelId,
          projectId: pid,
          roleBasedNameOnlyMode: boring,
        });
        setOwnSessionId(session.id);
        setFocusedSessionId(session.id);
        setActiveThreadTitle(displayThreadTitle(session.title));
        return true;
      } catch (err) {
        note(`could not start a session: ${errMsg(err)}`, 'error');
        return false;
      }
    },
    [client, note, boring],
  );

  const switchProject = useCallback(
    async (id: string) => {
      setOverlay(null);
      const project = projects.find((candidate) => candidate.id === id);
      if (!project || id === projectId) return;
      try {
        const gezelId = project.voormanGezelId ?? (await ensureCliProjectLead(client, id));
        setProjectId(id);
        setProjectName(project.name);
        setActiveGezelId(gezelId);
        setRows([]);
        setRecentOpenReferences([]);
        setTurns(new Map());
        setActiveRuns(new Set());
        setPendingInput(null);
        setPendingQuestions([]);
        setThreads([]);
        setActiveThreadTitle(null);
        setTasks([]);
        setCraftbooks([]);
        setCraftbookProjectType(null);
        setSuggestedCraftbookIds(new Set());
        setCraftbooksNeedingSetup(new Set());
        setStartCategoryId(null);
        setManagedTaskRef(null);
        setTaskPrompt(null);
        await ensureSession(gezelId, id);
      } catch (err) {
        note(`could not switch project: ${errMsg(err)}`, 'error');
      }
    },
    [client, ensureSession, note, projectId, projects, setRows, setTurns],
  );

  const openModelPicker = useCallback(async () => {
    if (!activeGezelId || !activeGezel) return note('no active gezel yet.', 'error');
    if (activeGezel.fixedFunction) {
      return note('this gezel runs a fixed tool and does not use a chat model.', 'error');
    }
    if (modelChoicesLoading) return note('model choices are already loading.');
    setModelChoicesLoading(true);
    note('loading available engines and models…');
    try {
      const choices = await loadModelChoices(client, config ?? (await client.getConfig()));
      setModelChoices(choices);
      setOverlay('model');
    } catch (err) {
      note(`could not load models: ${errMsg(err)}`, 'error');
    } finally {
      setModelChoicesLoading(false);
    }
  }, [activeGezel, activeGezelId, client, config, modelChoicesLoading, note]);

  const openModelDownloadPicker = useCallback(
    async (returnTo: 'model' | null = null) => {
      if (!activeGezelId || !activeGezel) return note('no active gezel yet.', 'error');
      if (activeGezel.fixedFunction) {
        return note('this gezel runs a fixed tool and does not use a chat model.', 'error');
      }
      if (modelChoicesLoading) return note('model choices are already loading.');
      setOverlay(null);
      setModelChoicesLoading(true);
      note('finding on-device models that fit this machine…');
      try {
        const choices = await loadModelDownloadChoices(
          client,
          config ?? (await client.getConfig()),
        );
        if (choices.length === 0) {
          note('no additional compatible on-device models are available to download.');
          if (returnTo === 'model') await openModelPicker();
          return;
        }
        setModelDownloadChoices(choices);
        setModelDownloadProgress(null);
        setModelDownloadReturn(returnTo);
        setOverlay('model-download');
      } catch (err) {
        note(`could not load downloadable models: ${errMsg(err)}`, 'error');
      } finally {
        setModelChoicesLoading(false);
      }
    },
    [activeGezel, activeGezelId, client, config, modelChoicesLoading, note, openModelPicker],
  );

  const openThreadPicker = useCallback(async () => {
    if (!activeGezelId) return note('no active gezel yet.', 'error');
    if (threadsLoading) return;
    setThreadsLoading(true);
    try {
      const result = await client.listChatSessions({ gezelId: activeGezelId, projectId });
      setThreads(result.sessions.filter((session) => !session.archived && !session.taskRef));
      setOverlay('thread');
    } catch (err) {
      note(`could not load threads: ${errMsg(err)}`, 'error');
    } finally {
      setThreadsLoading(false);
    }
  }, [activeGezelId, client, note, projectId, threadsLoading]);

  const switchThread = useCallback(
    async (sessionId: string) => {
      setOverlay(null);
      try {
        const session = await client.getChatSession(sessionId);
        if (session.gezelId !== activeGezelId || session.projectId !== projectId) {
          throw new Error('thread no longer belongs to the active gezel and project');
        }
        setOwnSessionId(session.id);
        setFocusedSessionId(session.id);
        setActiveThreadTitle(displayThreadTitle(session.title));
        setRows(sessionToFeedRows(session, { showThinking: config?.cliShowThinking !== false }));
        setRecentOpenReferences(cliOpenReferencesFromSession(session));
      } catch (err) {
        note(`could not switch thread: ${errMsg(err)}`, 'error');
      }
    },
    [activeGezelId, client, config?.cliShowThinking, note, projectId, setRows],
  );

  const startNewThread = useCallback(async () => {
    setOverlay(null);
    if (!activeGezelId) return note('no active gezel yet.', 'error');
    try {
      const session = await client.createChatSession({
        gezelId: activeGezelId,
        projectId,
        roleBasedNameOnlyMode: boring,
      });
      setOwnSessionId(session.id);
      setFocusedSessionId(session.id);
      setActiveThreadTitle(displayThreadTitle(session.title));
      setRows([]);
      setRecentOpenReferences([]);
      setThreads((current) => [session, ...current.filter((item) => item.id !== session.id)]);
    } catch (err) {
      note(`could not start a thread: ${errMsg(err)}`, 'error');
    }
  }, [activeGezelId, boring, client, note, projectId, setRows]);

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
        applyGezelSnapshot(gz.gezels);
        const projectRows = pj.projects.map((p) => ({
          id: p.id,
          name: p.name,
          workingDir: p.workingDir,
          voormanGezelId: p.voormanGezelId,
          managedWorkspaceWritePolicy: p.managedWorkspaceWritePolicy,
          allowGezelWrites: p.allowGezelWrites,
          codexPermissionMode: p.codexPermissionMode,
          claudePermissionMode: p.claudePermissionMode,
        }));
        setProjects(projectRows);
        const gezelId = props.initialGezelId;
        const initialGezel = gz.gezels.find((gezel) => gezel.id === gezelId);
        const initialProject = projectRows.find((project) => project.id === projectId);
        setActiveGezelId(gezelId);
        setStatus(null);
        if (
          activeAccessMode({
            provider: initialGezel?.provider ?? cfg.provider,
            project: initialProject,
            gezel: initialGezel,
            config: cfg,
          }) === 'read-only'
        ) {
          note(READ_ONLY_BOOT_NOTE);
        }
        await ensureSession(gezelId, projectId);
      } catch (err) {
        if (!cancelled) setStatus(`Failed to connect: ${errMsg(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recover questions that were already waiting before this TUI connected.
  // Live additions/removals arrive through the project SSE handler above.
  useEffect(() => {
    let cancelled = false;
    setPendingQuestions([]);
    void client
      .listQuestions({ projectId, pending: true })
      .then((result) => {
        if (!cancelled) setPendingQuestions(pendingQuestionsForTui(result.questions));
      })
      .catch(() => {
        /* non-fatal — a later question_asked event still surfaces */
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId]);

  // Seed tasks for the active project and retain a slow fallback poll in
  // case a daemon restart interrupts SSE. Normal changes refresh instantly
  // via `task_event` above. Deliberately NOT polling
  // /api/config here: that endpoint reads provider credentials from the
  // OS keychain, which (under a bare `node` dev run) re-prompts on every
  // read. Provider is read once in the initial load; it rarely changes
  // mid-session. `listTasks` only touches task files.
  useEffect(() => {
    void refreshTasks();
    const id = setInterval(() => void refreshTasks(), 30_000);
    return () => {
      clearInterval(id);
    };
  }, [refreshTasks]);

  // Keep the active project's craftbooks warm so `/do ` can wordwheel
  // immediately. A manual `/do` retries and surfaces an error if this
  // background refresh failed.
  useEffect(() => {
    void refreshCraftbooks().catch(() => {
      /* non-fatal — /do retries with visible error handling */
    });
  }, [refreshCraftbooks]);

  const managedTask = useMemo(
    () => tasks.find((task) => task.ref === managedTaskRef),
    [managedTaskRef, tasks],
  );
  const startCategories = useMemo(
    () => craftbookCategories(craftbooks, suggestedCraftbookIds, craftbookProjectType),
    [craftbookProjectType, craftbooks, suggestedCraftbookIds],
  );
  const startCategory = useMemo(
    () => startCategories.find((category) => category.id === startCategoryId),
    [startCategories, startCategoryId],
  );
  const startCategoryBooks = useMemo(
    () =>
      startCategory ? craftbooks.filter((book) => startCategory.bookIds.has(book.id)) : craftbooks,
    [craftbooks, startCategory],
  );

  const gezelLine = useMemo(() => {
    const g = gezels.find((x) => x.id === activeGezelId);
    if (!g) return '…';
    if (boring) return g.roleBasedName ?? g.role ?? g.id;
    return g.role ? `${g.name} · ${g.role}` : g.name;
  }, [gezels, activeGezelId, boring]);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === projectId),
    [projects, projectId],
  );
  const accessMode = useMemo(
    () =>
      activeAccessMode({
        provider: effectiveProvider,
        project: activeProject,
        gezel: activeGezel,
        config,
      }),
    [activeGezel, activeProject, config, effectiveProvider],
  );

  // Distinct active chat sessions seen in the feed — targets for /focus.
  const focusItems = useMemo<PickerItem[]>(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.sessionId === 'local' || r.sessionId.startsWith('term-')) continue;
      if (!seen.has(r.sessionId)) {
        const gezel = gezels.find((candidate) => candidate.id === r.gezelId);
        const label = boring
          ? gezelLabel(r.gezelId, gezels, true)
          : (gezel?.name ?? (r.gezelId || r.sessionId));
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
  }, [rows, gezels, ownSessionId, gezelLine, boring]);

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

  const rememberTask = useCallback((task: Task) => {
    setTasks((current) => sortTasks([...current.filter((item) => item.ref !== task.ref), task]));
  }, []);

  const applyEngagementMode = useCallback(
    async (requested: string) => {
      const next = parseCliEngagementMode(requested);
      if (!next) {
        note(`usage: /mode ${CLI_ENGAGEMENT_MODE_USAGE}`, 'error');
        return;
      }
      const option = cliEngagementModeOption(next);
      setOverlay(null);
      try {
        const updated = await client.updateConfig({ aiEngagementMode: next });
        setConfig(updated);
        note(`AI mode → ${option.label}. ${option.description}`);
      } catch (err) {
        note(`could not change AI mode: ${errMsg(err)}`, 'error');
      }
    },
    [client, note],
  );

  const applyProjectPermission = useCallback(
    async (permission: string, allowed: boolean) => {
      const permissionName = parseProjectPermissionName(permission);
      if (!permissionName) {
        note(`usage: /${allowed ? 'allow' : 'disallow'} ${PROJECT_PERMISSION_USAGE}`, 'error');
        return;
      }
      try {
        const patch =
          permissionName === 'edits'
            ? { managedWorkspaceWritePolicy: allowed ? ('allow' as const) : ('deny' as const) }
            : permissionName === 'codexedits'
              ? { codexPermissionMode: allowed ? ('edit' as const) : ('plan' as const) }
              : { claudePermissionMode: allowed ? ('acceptEdits' as const) : ('plan' as const) };
        const updated = await client.updateProject(projectId, patch);
        setProjects((current) =>
          current.map((project) =>
            project.id === projectId ? { ...project, ...updated } : project,
          ),
        );
        if (permissionName === 'edits') {
          note(
            allowed
              ? `Project edits allowed. Built-in tools and background work can now modify ${projectName}.`
              : `Project edits disallowed. Built-in tools and background work are now read-only in ${projectName}.`,
          );
        } else {
          const provider = permissionName === 'codexedits' ? 'Codex' : 'Claude';
          note(
            allowed
              ? `${provider} edits allowed. ${provider} sessions can now modify ${projectName}.`
              : `${provider} edits disallowed. ${provider} sessions are now read-only in ${projectName}.`,
          );
        }
      } catch (err) {
        note(`could not change project permission: ${errMsg(err)}`, 'error');
      }
    },
    [client, note, projectId, projectName],
  );

  const applyChatDetailVisibility = useCallback(
    async (requested: string, visible: boolean) => {
      const target = requested.trim().toLowerCase();
      if (target !== 'thinking' && target !== 'writes') {
        note(`usage: /${visible ? 'show' : 'hide'} thinking|writes`, 'error');
        return;
      }
      try {
        const updated = await client.updateConfig(
          target === 'thinking' ? { cliShowThinking: visible } : { cliShowWrites: visible },
        );
        setConfig(updated);
        if (!visible) {
          const kind = target === 'thinking' ? 'thinking' : 'write';
          setRows((current) => current.filter((row) => row.kind !== kind));
        }
        if (target === 'thinking') {
          note(
            visible
              ? 'Thinking is now shown inline.'
              : 'Thinking is now hidden. The live token count still includes it.',
          );
        } else {
          note(
            visible
              ? 'Write content is now shown inline as it streams.'
              : 'Write content is now hidden. Tool token counts remain visible.',
          );
        }
      } catch (err) {
        note(`could not ${visible ? 'show' : 'hide'} ${target}: ${errMsg(err)}`, 'error');
      }
    },
    [client, note, setRows],
  );

  const startCraftbook = useCallback(
    async (book: StartCraftbook) => {
      setOverlay(null);
      note(`starting ${book.name}…`);
      try {
        const created = await client.createTask(projectId, {
          ...craftbookStartRequest(book),
          roleBasedNameOnlyMode: boring,
        });
        rememberTask(created);
        setManagedTaskRef(created.ref);
        note(`started ${created.ref} — ${created.title}`);
      } catch (err) {
        note(`could not start ${book.name}: ${errMsg(err)}`, 'error');
      }
    },
    [boring, client, note, projectId, rememberTask],
  );

  const submitTaskPrompt = useCallback(
    async (raw: string) => {
      const prompt = taskPrompt;
      if (!prompt) return;
      const text = raw.trim();
      if (!text) {
        note('task edit canceled.');
        setTaskPrompt(null);
        return;
      }
      setTaskPrompt(null);
      try {
        if (prompt.kind === 'create') {
          const created = await client.createTask(projectId, {
            title: text,
            description: `${text} — complete this task and verify that the result meets the requested outcome.`,
            assignee: { kind: 'user' },
            steps: [{ name: 'Main' }],
            roleBasedNameOnlyMode: boring,
          });
          rememberTask(created);
          setManagedTaskRef(created.ref);
          setOverlay('task-actions');
          return;
        }
        const task = tasks.find((item) => item.ref === prompt.taskRef);
        if (!task) throw new Error(`task ${prompt.taskRef ?? ''} is no longer available`);
        const updated = await client.updateTask(task.projectId, task.num, {
          [prompt.kind]: text,
        });
        rememberTask(updated);
        setManagedTaskRef(updated.ref);
        setOverlay('task-actions');
      } catch (err) {
        note(`task update failed: ${errMsg(err)}`, 'error');
      }
    },
    [boring, client, note, projectId, rememberTask, taskPrompt, tasks],
  );

  const applyTaskStatus = useCallback(
    async (status: TaskStatus) => {
      const task = managedTask;
      if (!task) return setOverlay('task');
      setOverlay(null);
      try {
        const updated =
          task.status === 'draft' && status === 'active'
            ? await client.activateTask(task.projectId, task.num)
            : await client.setTaskStatus(task.projectId, task.num, status);
        rememberTask(updated);
        setManagedTaskRef(updated.ref);
        setOverlay('task-actions');
      } catch (err) {
        note(`could not change ${task.ref}: ${errMsg(err)}`, 'error');
      }
    },
    [client, managedTask, note, rememberTask],
  );

  const applyTaskAssignee = useCallback(
    async (value: string) => {
      const task = managedTask;
      if (!task) return setOverlay('task');
      setOverlay(null);
      try {
        const updated = await client.setTaskAssignee(
          task.projectId,
          task.num,
          value === '__user__' ? { kind: 'user' } : { kind: 'gezel', gezelId: value },
        );
        rememberTask(updated);
        setManagedTaskRef(updated.ref);
        setOverlay('task-actions');
      } catch (err) {
        note(`could not reassign ${task.ref}: ${errMsg(err)}`, 'error');
      }
    },
    [client, managedTask, note, rememberTask],
  );

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
      if (taskPrompt) {
        await submitTaskPrompt(raw);
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
            await client.sendToChatSession(
              target,
              turns.has(target) ? { message: parsed.text, nudge: true } : parsed.text,
            );
          } catch (err) {
            note(`send failed: ${errMsg(err)}`, 'error');
          }
          return;
        }
        case 'shell': {
          if (!parsed.text) return;
          note(`$ ${parsed.text}`, 'shell');
          try {
            await client.runTerminalCommand(projectId, {
              workingDir: '',
              input: parsed.text,
              columns: shellColumns,
            });
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
    [
      client,
      mode,
      projectId,
      shellColumns,
      focusedSessionId,
      ownSessionId,
      note,
      pendingInput,
      submitTaskPrompt,
      taskPrompt,
      turns,
    ],
  );

  const runCommand = useCallback(
    async (name: string, rest: string) => {
      switch (name) {
        case 'help':
        case '?':
          for (const line of HELP) note(line);
          return;
        case 'project':
          return setOverlay('project');
        case 'gezel':
          return setOverlay('gezel');
        case 'allow':
          await applyProjectPermission(rest, true);
          return;
        case 'disallow':
          await applyProjectPermission(rest, false);
          return;
        case 'show':
          await applyChatDetailVisibility(rest, true);
          return;
        case 'hide':
          await applyChatDetailVisibility(rest, false);
          return;
        case 'mode':
          if (!rest.trim()) return setOverlay('engagement-mode');
          await applyEngagementMode(rest);
          return;
        case 'model': {
          const subcommand = rest.trim().toLowerCase();
          if (!subcommand) return openModelPicker();
          if (subcommand === 'download') return openModelDownloadPicker();
          return note('usage: /model [download]', 'error');
        }
        case 'thread':
          await openThreadPicker();
          return;
        case 'open': {
          const target = resolveCliOpenTarget(rest, recentOpenReferencesRef.current);
          if (!target) {
            return note(
              'usage: /open workspace|artifacts|<recent file> (type /open and a space to browse)',
              'error',
            );
          }
          try {
            if (target.type === 'folder') {
              const result = await client.revealProject(projectId, target.folder);
              note(`opened ${target.folder}: ${result.path}`);
            } else {
              const result = await client.revealProjectReference(target.reference.projectId, {
                kind: target.reference.kind,
                path: target.reference.path,
              });
              setRecentOpenReferences((current) =>
                rememberCliOpenReferences(current, [target.reference]),
              );
              note(`revealed ${target.reference.path}: ${result.path}`);
            }
          } catch (err) {
            note(`open failed: ${errMsg(err)}`, 'error');
          }
          return;
        }
        case 'task':
          setManagedTaskRef(null);
          return setOverlay('task');
        case 'continue': {
          try {
            const result = await client.continueProject(projectId);
            await refreshTasks();
            const activeCount = result.activeTaskRefs.length;
            const scheduledCount = result.scheduledTaskRefs.length;
            const heldScheduledCount = result.heldScheduledTaskRefs.length;
            const spawnedCount = result.spawnedTaskRefs.length;
            const deferredCount = result.deferredNightShiftTaskRefs.length;
            const parts: string[] = [];
            if (scheduledCount > 0) {
              parts.push(
                `processed ${scheduledCount} due schedule${scheduledCount === 1 ? '' : 's'}${
                  spawnedCount > 0
                    ? ` and spawned ${spawnedCount} task${spawnedCount === 1 ? '' : 's'}`
                    : ''
                }`,
              );
            }
            if (activeCount > 0) {
              parts.push(`reconciled ${activeCount} active task${activeCount === 1 ? '' : 's'}`);
            }
            if (heldScheduledCount > 0) {
              parts.push(
                `held ${heldScheduledCount} due schedule${heldScheduledCount === 1 ? '' : 's'}`,
              );
            }
            if (deferredCount > 0) {
              parts.push(
                `left ${deferredCount} Night Shift task${deferredCount === 1 ? '' : 's'} queued for the shift`,
              );
            }
            if (parts.length === 0) {
              if (result.projectStatus !== 'active') {
                note(`${projectName} is ${result.projectStatus}; no project work was started.`);
              } else {
                note(`no due schedules or gezel-owned active tasks found in ${projectName}.`);
              }
            } else {
              note(`continue: ${parts.join('; ')}.`);
            }
            if (result.holdReason) note(projectContinueHoldMessage(result.holdReason));
          } catch (err) {
            note(`could not continue ${projectName}: ${errMsg(err)}`, 'error');
          }
          return;
        }
        case 'do': {
          let available = craftbooks;
          if (available.length === 0) {
            try {
              available = await refreshCraftbooks();
            } catch (err) {
              return note(`could not load craftbooks: ${errMsg(err)}`, 'error');
            }
          }
          if (available.length === 0) {
            return note('no craftbooks are available for this project.', 'error');
          }
          if (!rest.trim()) {
            setStartCategoryId(null);
            return setOverlay('start-category');
          }
          const book = findCraftbook(available, rest);
          if (!book) {
            return note(`craftbook not found: ${rest.trim()} (try /do)`, 'error');
          }
          await startCraftbook(book);
          return;
        }
        case 'nightshift': {
          const subcommand = rest.trim().toLowerCase();
          if (!['start', 'stop', 'list'].includes(subcommand)) {
            return note('usage: /nightshift start|stop|list', 'error');
          }
          try {
            if (subcommand === 'start') {
              const state = await client.setNightShiftManual('start');
              if (state.active) {
                note(`night shift started${state.source ? ` (${state.source})` : ''}.`);
              } else {
                note(
                  'night shift stayed off — there is no pending night-shift work, or Night Shift is disabled.',
                );
              }
              return;
            }
            if (subcommand === 'stop') {
              await client.setNightShiftManual('stop');
              note('night shift stopped; work already in flight may finish.');
              return;
            }
            const [state, work] = await Promise.all([
              client.getNightShiftStatus(),
              client.getNightShiftTasks(),
            ]);
            note(formatNightShiftList(state, work));
          } catch (err) {
            note(`night shift command failed: ${errMsg(err)}`, 'error');
          }
          return;
        }
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
    [
      applyEngagementMode,
      applyProjectPermission,
      applyChatDetailVisibility,
      client,
      craftbooks,
      note,
      exit,
      openModelDownloadPicker,
      openModelPicker,
      openThreadPicker,
      projectId,
      projectName,
      refreshCraftbooks,
      refreshTasks,
      setRows,
      setTurns,
      startCraftbook,
    ],
  );

  const applyModelSelection = useCallback(
    async (choice?: ModelChoice) => {
      setOverlay(null);
      if (!activeGezelId || !activeGezel || !config) return;
      const nextProvider = choice?.provider ?? null;
      const nextModel = choice?.model.id;
      const providerChanged = (activeGezel.provider ?? null) !== nextProvider;
      try {
        const updated = await client.updateGezelSettings(activeGezelId, {
          provider: nextProvider,
          model: nextModel ?? null,
          ...(providerChanged || !nextModel ? { reasoningEffort: null } : {}),
        });
        setGezels((current) =>
          current.map((gezel) => (gezel.id === activeGezelId ? updated : gezel)),
        );
        const started = await ensureSession(activeGezelId, projectId);
        const sessionNote = started ? '; started a new chat.' : '.';
        if (choice) note(`model → ${choice.label}${sessionNote}`);
        else {
          const defaultModel = config.defaultModel?.[config.provider];
          const identity = defaultModel
            ? `${modelProviderLabel(config.provider)} · ${defaultModel}`
            : modelProviderLabel(config.provider);
          note(`model → default (${identity})${sessionNote}`);
        }
      } catch (err) {
        note(`could not switch model: ${errMsg(err)}`, 'error');
      }
    },
    [activeGezel, activeGezelId, client, config, ensureSession, note, projectId],
  );

  const applyModelChoice = useCallback(
    async (value: string) => {
      await applyModelSelection(modelChoices.find((item) => item.value === value));
    },
    [applyModelSelection, modelChoices],
  );

  const installModelDownload = useCallback(
    async (value: string) => {
      const choice = modelDownloadChoices.find((candidate) => candidate.value === value);
      if (!choice) return;
      let terminalError: string | null = null;
      const companionResult: { name: string | null; error: string | null } = {
        name: null,
        error: null,
      };
      setModelDownloadProgress({
        choice,
        bytesWritten: 0,
        totalBytes: choice.model.approxSizeBytes,
        pct: 0,
        phase: 'starting',
      });
      const onEvent = (event: LlamaCppInstallEvent | MlxInstallEvent) => {
        if (event.type === 'error') terminalError = event.error;
        if (event.type === 'companion') {
          companionResult.name = event.name;
          if (event.error) companionResult.error = event.error;
        }
        const progress = readModelDownloadProgress(choice, event);
        if (progress) setModelDownloadProgress(progress);
      };
      try {
        if (choice.provider === 'mlx') {
          await client.installMlxModel(choice.model.id, onEvent);
        } else {
          await client.installLlamaCppModel(choice.model.id, onEvent);
        }
        if (terminalError) throw new Error(terminalError);
        const installedChoice: ModelChoice = {
          provider: choice.provider,
          model: {
            id: choice.model.id,
            name: choice.model.name,
          },
          value: choice.value,
          label: `${modelProviderLabel(choice.provider)} · ${choice.model.name}`,
        };
        setModelChoices((current) => [
          ...current.filter((candidate) => candidate.value !== installedChoice.value),
          installedChoice,
        ]);
        setModelDownloadProgress(null);
        if (companionResult.name && companionResult.error) {
          note(
            `downloaded ${choice.model.name}; ${companionResult.name} image reader could not be added: ${companionResult.error}. Switching this gezel to ${choice.model.name}…`,
          );
        } else if (companionResult.name) {
          note(
            `downloaded ${choice.model.name} with ${companionResult.name} for image reading; switching this gezel to it…`,
          );
        } else {
          note(`downloaded ${choice.model.name}; switching this gezel to it…`);
        }
        await applyModelSelection(installedChoice);
      } catch (err) {
        setModelDownloadProgress(null);
        setOverlay('model-download');
        note(`model download failed: ${errMsg(err)}`, 'error');
      }
    },
    [applyModelSelection, client, modelDownloadChoices, note],
  );

  const cancelModelDownload = useCallback(async () => {
    const progress = modelDownloadProgress;
    if (!progress) return;
    try {
      if (progress.choice.provider === 'mlx') {
        await client.cancelMlxModelInstall(progress.choice.model.id);
      } else {
        await client.cancelLlamaCppModelInstall(progress.choice.model.id);
      }
      note(`canceled the ${progress.choice.model.name} download.`);
    } catch (err) {
      note(`could not cancel model download: ${errMsg(err)}`, 'error');
    } finally {
      setModelDownloadProgress(null);
      if (modelDownloadReturn === 'model') await openModelPicker();
      else setOverlay(null);
    }
  }, [client, modelDownloadProgress, modelDownloadReturn, note, openModelPicker]);

  const onSubmit = useCallback(
    (raw: string) => {
      setValue('');
      // Record real submissions for ↑/↓ recall — but never stdin answers
      // (which may be passwords) and never bare blanks.
      const trimmed = raw.trim();
      if (trimmed && !pendingInput && !taskPrompt) {
        setHistory((h) => (h[h.length - 1] === trimmed ? h : [...h, trimmed].slice(-100)));
      }
      void runInput(raw);
    },
    [runInput, pendingInput, taskPrompt],
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
        } else if (taskPrompt) {
          setTaskPrompt(null);
          note('task edit canceled.');
        } else if (ownSessionId) {
          setFocusedSessionId(ownSessionId);
        }
      }
    },
    {
      isActive:
        overlay === null && (!pendingQuestion || pendingInput !== null || taskPrompt !== null),
    },
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
          onSelect={(id) => void switchProject(id)}
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
            setThreads([]);
            setActiveThreadTitle(null);
            void ensureSession(id, projectId);
          }}
        />
      ) : null}
      {overlay === 'engagement-mode' ? (
        <Picker
          title="Choose AI engagement mode"
          items={CLI_ENGAGEMENT_MODES.map((option) => ({
            label: option.label,
            value: option.name,
            hint: option.description,
          }))}
          initialValue={cliEngagementModeOption(config?.aiEngagementMode).name}
          onCancel={() => setOverlay(null)}
          onSelect={(selected) => void applyEngagementMode(selected)}
        />
      ) : null}
      {overlay === 'model' ? (
        <Picker
          title="Choose engine + model - models are downloaded from Hugging Face (huggingface.co)"
          items={[
            {
              label: 'Use default',
              value: '__default__',
              hint: `${modelProviderLabel(config?.provider ?? 'llama-cpp')}${
                config?.defaultModel?.[config.provider]
                  ? ` · ${config.defaultModel[config.provider]}`
                  : ''
              }`,
            },
            {
              label: 'Download a new model…',
              value: '__download__',
              hint: 'browse on-device models ranked for this machine',
            },
            ...modelChoices.map((choice) => ({
              label: choice.label,
              value: choice.value,
              hint:
                activeGezel?.provider === choice.provider && activeGezel.model === choice.model.id
                  ? 'current'
                  : choice.model.supportsReasoning
                    ? 'reasoning'
                    : undefined,
            })),
          ]}
          initialValue={
            activeGezel?.provider && activeGezel.model
              ? `${activeGezel.provider}:${activeGezel.model}`
              : '__default__'
          }
          windowSize={modelPickerWindowSize}
          onCancel={() => setOverlay(null)}
          onSelect={(value) => {
            if (value === '__download__') void openModelDownloadPicker('model');
            else void applyModelChoice(value);
          }}
        />
      ) : null}
      {overlay === 'model-download' ? (
        modelDownloadProgress ? (
          <ModelDownloadProgressPanel
            progress={modelDownloadProgress}
            onCancel={() => void cancelModelDownload()}
          />
        ) : (
          <Picker
            title="Download and use an on-device model"
            items={modelDownloadChoices.map((choice) => ({
              label: choice.label,
              value: choice.value,
              hint: choice.hint,
            }))}
            windowSize={modelPickerWindowSize}
            onCancel={() => {
              if (modelDownloadReturn === 'model') setOverlay('model');
              else setOverlay(null);
            }}
            onSelect={(value) => void installModelDownload(value)}
          />
        )
      ) : null}
      {overlay === 'start-category' ? (
        <Picker
          title="Choose a craftbook category"
          items={startCategories.map((category) => ({
            label: category.label,
            value: category.id,
            hint: category.hint,
          }))}
          windowSize={modelPickerWindowSize}
          onCancel={() => setOverlay(null)}
          onSelect={(id) => {
            setStartCategoryId(id);
            setOverlay('start-craftbook');
          }}
        />
      ) : null}
      {overlay === 'start-craftbook' ? (
        <Picker
          title={startCategory?.label ?? 'Start a craftbook'}
          items={startCategoryBooks.map((book) => ({
            label: book.name,
            value: book.id,
            hint: `${book.stepCount} ${book.stepCount === 1 ? 'step' : 'steps'} · ${book.source}${
              craftbooksNeedingSetup.has(book.id) ? ' · needs setup' : ''
            }`,
          }))}
          windowSize={modelPickerWindowSize}
          onCancel={() => setOverlay('start-category')}
          onSelect={(id) => {
            const book = startCategoryBooks.find((item) => item.id === id);
            if (book) void startCraftbook(book);
          }}
        />
      ) : null}
      {overlay === 'thread' ? (
        <Picker
          title={`Threads with ${gezelLine}`}
          items={[
            { label: 'Start new thread…', value: '__new__' },
            ...threads.map((thread) => ({
              label: displayThreadTitle(thread.title),
              value: thread.id,
              hint: threadHint(thread, thread.id === ownSessionId),
            })),
          ]}
          initialValue={ownSessionId ?? '__new__'}
          windowSize={Math.max(4, Math.min(10, termRows - 12))}
          onCancel={() => setOverlay(null)}
          onSelect={(sessionId) => {
            if (sessionId === '__new__') void startNewThread();
            else void switchThread(sessionId);
          }}
        />
      ) : null}
      {overlay === 'task' ? (
        <Picker
          title={`Tasks · ${tasks.filter((task) => task.status === 'active').length} active`}
          items={[
            { label: 'Create task…', value: '__create__', hint: 'new active task' },
            ...tasks.map((task) => ({
              label: `${task.ref}  ${task.title}`,
              value: task.ref,
              hint: `${task.status} · ${taskAssigneeLabel(task, gezels, boring)}`,
            })),
          ]}
          windowSize={Math.max(4, Math.min(10, termRows - 12))}
          onCancel={() => setOverlay(null)}
          onSelect={(ref) => {
            if (ref === '__create__') {
              setOverlay(null);
              setTaskPrompt({ kind: 'create', promptLine: 'Task title' });
              return;
            }
            setManagedTaskRef(ref);
            setOverlay('task-actions');
          }}
        />
      ) : null}
      {overlay === 'task-actions' && managedTask ? (
        <Picker
          title={`${managedTask.ref} · ${managedTask.status}`}
          items={[
            { label: 'Show details', value: 'show', hint: managedTask.title },
            { label: 'Edit title…', value: 'title' },
            { label: 'Edit description…', value: 'description' },
            {
              label: 'Change assignee…',
              value: 'assignee',
              hint: taskAssigneeLabel(managedTask, gezels, boring),
            },
            { label: 'Change status…', value: 'status', hint: managedTask.status },
          ]}
          onCancel={() => setOverlay('task')}
          onSelect={(action) => {
            if (action === 'show') {
              setOverlay(null);
              note(formatTaskDetails(managedTask, gezels, boring));
            } else if (action === 'title' || action === 'description') {
              setOverlay(null);
              setTaskPrompt({
                kind: action,
                taskRef: managedTask.ref,
                promptLine: action === 'title' ? 'New task title' : 'New task description',
              });
            } else if (action === 'assignee') {
              setOverlay('task-assignee');
            } else if (action === 'status') {
              setOverlay('task-status');
            }
          }}
        />
      ) : null}
      {overlay === 'task-status' && managedTask ? (
        <Picker
          title={`Set ${managedTask.ref} status`}
          items={taskStatusChoices(managedTask)}
          onCancel={() => setOverlay('task-actions')}
          onSelect={(status) => void applyTaskStatus(status as TaskStatus)}
        />
      ) : null}
      {overlay === 'task-assignee' && managedTask ? (
        <Picker
          title={`Assign ${managedTask.ref}`}
          items={[
            {
              label: 'You',
              value: '__user__',
              hint: managedTask.assignee.kind === 'user' ? 'current' : undefined,
            },
            ...gezels.map((gezel) => ({
              label: boring ? (gezel.roleBasedName ?? gezel.role ?? gezel.id) : gezel.name,
              value: gezel.id,
              hint:
                managedTask.assignee.kind === 'gezel' && managedTask.assignee.gezelId === gezel.id
                  ? 'current'
                  : gezel.role,
            })),
          ]}
          onCancel={() => setOverlay('task-actions')}
          onSelect={(assignee) => void applyTaskAssignee(assignee)}
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
      {overlay === null && pendingQuestion ? (
        <QuestionPrompt
          key={pendingQuestion.id}
          client={client}
          question={pendingQuestion}
          askerLabel={gezelLabel(pendingQuestion.gezelId, gezels, boring)}
          active={pendingInput === null}
          onAnswered={(question) => {
            setPendingQuestions((questions) => updatePendingQuestion(questions, question));
            if (question.sessionId) setFocusedSessionId(question.sessionId);
          }}
        />
      ) : null}
      <PromptLine
        projectName={projectName}
        gezelLabel={gezelLine}
        threadTitle={activeThreadTitle ?? undefined}
        mode={mode}
        provider={effectiveProvider}
        model={effectiveModel}
        accessMode={accessMode}
        busy={busy}
        statusLabel={statusLabel}
        value={value}
        active={
          overlay === null && (!pendingQuestion || pendingInput !== null || taskPrompt !== null)
        }
        history={history}
        craftbooks={craftbooks}
        recentOpenReferences={recentOpenReferences}
        pendingPrompt={pendingInput?.promptLine ?? taskPrompt?.promptLine}
        pendingMode={pendingInput?.mode ?? (taskPrompt ? 'text' : undefined)}
        onChange={setValue}
        onSubmit={onSubmit}
      />
    </Box>
  );
}

function ModelDownloadProgressPanel(props: {
  progress: ModelDownloadProgress;
  onCancel: () => void;
}): JSX.Element {
  const { progress, onCancel } = props;
  const companion = progress.companion;
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) onCancel();
  });
  const transferred = progress.totalBytes
    ? `${formatModelBytes(progress.bytesWritten)} / ${formatModelBytes(progress.totalBytes)}`
    : formatModelBytes(progress.bytesWritten);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        {companion
          ? `Adding image reader: ${companion.name}`
          : `Downloading ${progress.choice.model.name}`}
      </Text>
      {companion ? (
        <Text>
          {progress.choice.model.name} is ready. This separate helper reads images for it.
        </Text>
      ) : null}
      <Text>
        {progress.pct == null ? 'Working…' : `${progress.pct}%`} · {transferred}
      </Text>
      {progress.phase ? <Text dimColor>{progress.phase}</Text> : null}
      <Text dimColor>Esc / Ctrl+C cancel</Text>
    </Box>
  );
}

function readModelDownloadProgress(
  choice: ModelDownloadChoice,
  event: LlamaCppInstallEvent | MlxInstallEvent,
): ModelDownloadProgress | null {
  if (event.type === 'progress') {
    const bytesWritten = 'bytesWrittenAll' in event ? event.bytesWrittenAll : event.bytesWritten;
    const totalBytes = 'totalBytesAll' in event ? event.totalBytesAll : event.totalBytes;
    return {
      choice,
      bytesWritten,
      totalBytes,
      pct: totalBytes > 0 ? Math.min(100, Math.floor((bytesWritten / totalBytes) * 100)) : null,
      phase: 'downloading and verifying model files',
    };
  }
  if (event.type === 'companion') {
    return {
      choice,
      bytesWritten: event.bytesWritten,
      totalBytes: event.totalBytes,
      pct:
        event.totalBytes > 0
          ? Math.min(100, Math.floor((event.bytesWritten / event.totalBytes) * 100))
          : null,
      companion: {
        kind: event.kind,
        id: event.id,
        name: event.name,
      },
    };
  }
  return null;
}

function formatModelBytes(bytes: number): string {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
    : `${Math.max(0, Math.round(bytes / 1_000_000))} MB`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function displayThreadTitle(title: string): string {
  return title === 'New session' ? 'New thread' : title;
}

function threadHint(thread: ChatSessionSummary, current: boolean): string {
  const engine = thread.model ? `${thread.providerName} · ${thread.model}` : thread.providerName;
  return [current ? 'current' : null, formatRelativeTime(thread.lastActivityAt), engine]
    .filter(Boolean)
    .join(' · ');
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const minutes = Math.floor(Math.max(0, Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function projectContinueHoldMessage(
  reason: 'engagement-off' | 'engagement-paused' | 'provider-busy',
): string {
  switch (reason) {
    case 'engagement-off':
      return 'project work is held because AI engagement is Off.';
    case 'engagement-paused':
      return 'project work is held because AI engagement is Reactive.';
    case 'provider-busy':
      return 'task work is queued until an engine slot is free.';
  }
}

function formatNightShiftList(
  state: { active: boolean; source: 'scheduled' | 'manual' | null },
  work: NightShiftTasksResponse,
): string {
  const lines = [
    `Night Shift: ${state.active ? `active${state.source ? ` (${state.source})` : ''}` : 'off'}`,
  ];
  if (work.background.length > 0) {
    lines.push('Background:');
    for (const item of work.background) {
      lines.push(`  - ${item.title}${item.detail ? ` — ${item.detail}` : ''}`);
    }
  }
  if (work.active.length > 0) {
    lines.push('Working on:');
    for (const task of work.active) lines.push(`  - ${formatNightShiftTask(task)}`);
  }
  if (work.upcoming.length > 0) {
    lines.push(state.active ? 'Up next:' : 'Queued for the next shift:');
    for (const task of work.upcoming) lines.push(`  - ${formatNightShiftTask(task)}`);
  }
  if (work.background.length + work.active.length + work.upcoming.length === 0) {
    lines.push('No work is running or queued.');
  }
  return lines.join('\n');
}

function formatNightShiftTask(task: NightShiftTasksResponse['active'][number]): string {
  return `${task.ref} ${task.title} — ${task.projectName}${task.stepName ? ` · ${task.stepName}` : ''}`;
}

const TASK_STATUS_ORDER: Record<TaskStatus, number> = {
  active: 0,
  draft: 1,
  paused: 2,
  complete: 3,
  canceled: 4,
};

function sortTasks(tasks: ReadonlyArray<Task>): Task[] {
  return [...tasks].sort((left, right) => {
    const byStatus = TASK_STATUS_ORDER[left.status] - TASK_STATUS_ORDER[right.status];
    if (byStatus !== 0) return byStatus;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

function taskAssigneeLabel(
  task: Task,
  gezels: ReadonlyArray<GezelSummary>,
  boring: boolean,
): string {
  if (task.assignee.kind === 'user') return 'you';
  const gezelId = task.assignee.gezelId;
  const gezel = gezels.find((item) => item.id === gezelId);
  if (!gezel) return boring ? 'gezel' : gezelId;
  return boring ? (gezel.roleBasedName ?? gezel.role ?? gezel.id) : gezel.name;
}

function taskStatusChoices(task: Task): PickerItem[] {
  const statuses: TaskStatus[] =
    task.status === 'draft'
      ? ['active', 'canceled']
      : task.origin?.kind === 'system-job'
        ? ['active', 'paused']
        : ['active', 'paused', 'complete', 'canceled'];
  const labels: Record<TaskStatus, string> = {
    draft: 'Move to draft',
    active: task.status === 'draft' ? 'Activate' : 'Resume / reopen',
    paused: 'Pause',
    complete: 'Mark complete',
    canceled: 'Cancel',
  };
  return statuses
    .filter((status) => status !== task.status)
    .map((status) => ({ label: labels[status], value: status }));
}

function formatTaskDetails(
  task: Task,
  gezels: ReadonlyArray<GezelSummary>,
  boring: boolean,
): string {
  const steps = task.craftbook.steps.map((step) => {
    const marker = step.completedAt ? '✓' : step.id === task.activeStepId ? '→' : '·';
    return `  ${marker} ${step.name}`;
  });
  return [
    `${task.ref} [${task.status}] ${task.title}`,
    `assignee: ${taskAssigneeLabel(task, gezels, boring)}`,
    ...(task.description ? [`description: ${task.description}`] : []),
    ...(steps.length > 0 ? ['steps:', ...steps] : []),
  ].join('\n');
}
