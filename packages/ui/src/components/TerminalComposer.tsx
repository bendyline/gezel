import { type ReactNode, Suspense, lazy, useCallback, useRef, useState } from 'react';
import { api } from '../api.js';
import { Popover } from '../primitives/index.js';
import { CommandsPanel, type CommandsPanelSection } from './CommandsPanel.js';
import type { TerminalCodeEditorHandle } from './terminal-editor/TerminalCodeEditor.js';
import { useTerminalCompletionSources } from './terminal-editor/use-terminal-completion-sources.js';

/**
 * Monaco terminal surface, lazy-loaded so monaco's chunk stays out of the
 * app's static graph (and out of jsdom — tests mock this module). The
 * fallback is a non-interactive placeholder for the brief first-load window.
 */
const TerminalCodeEditor = lazy(() => import('./terminal-editor/TerminalCodeEditor.js'));

const TERMINAL_PLACEHOLDER =
  'build, test, git status, … — Enter runs, Shift+Enter for newline, ↑/↓ recalls history';

/**
 * Module-level queue for staging a command into the terminal from
 * elsewhere (the CommandsPanel craftbook launcher). `stageTerminalCommand`
 * in `ProjectChat` calls `queueTerminalCommand(projectId, cmd)` then
 * ensures terminal mode + remounts this composer; the next mount for that
 * project consumes the entry as its initial input. Keyed by projectId so
 * a stage for project A doesn't clobber B. Mirrors `queueComposerPrefill`
 * in ChatComposer — a `window` event would race the listener's mount.
 */
const pendingTerminalCommands = new Map<string, string>();
export function queueTerminalCommand(projectId: string, command: string): void {
  pendingTerminalCommands.set(projectId, command);
}

/**
 * The toolbar's three galleries. Splitting one "Commands" button into three
 * separates three genuinely different questions — how do I use a terminal at
 * all, what does this repo already know how to run, and what work can a gezel
 * pick up — so a first-time user isn't handed a mixed list and left to sort
 * out which is which. All three render the same `CommandsPanel`, scoped.
 */
const GALLERIES: Array<{
  section: Exclude<CommandsPanelSection, 'all'>;
  label: string;
  title: string;
  icon: ReactNode;
}> = [
  {
    section: 'commands',
    label: 'Commands',
    title: 'Everyday terminal commands, and the tools installed on this machine',
    icon: (
      <>
        <path
          d="M2.5 4 L6 8 L2.5 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M8 12 H13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
  },
  {
    section: 'scripts',
    label: 'Scripts',
    title: 'Scripts this project already defines — package.json, scripts/, launches',
    icon: (
      <>
        <rect
          x="3"
          y="2"
          width="10"
          height="12"
          rx="1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path
          d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </>
    ),
  },
  {
    section: 'tasks',
    label: 'Tasks',
    title: 'Craftbooks and workspace skills a gezel can run for you',
    icon: (
      <>
        <path
          d="M2.5 4.5 L4 6 L6.5 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M8.5 5 H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path
          d="M2.5 11 L4 12.5 L6.5 9.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M8.5 11.5 H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
  },
];

/**
 * Shell-flavored input backed by a Monaco editor (see `TerminalCodeEditor`),
 * with rich context-sensitive autocomplete for the project's commands,
 * craftbooks, MCP tools, and file paths. This component is the thin
 * controller: it owns submit, the in-memory run-history buffer, the queued-
 * command seed, and the error banner; the editor owns the buffer + keystrokes
 * and surfaces them through the imperative handle + callbacks.
 *
 * Submission is optimistic: the buffer clears + the command pushes onto
 * history BEFORE the server round-trip, so the user can fire
 * `ls<enter> pwd<enter>` without waiting for each command's output. The
 * empty-trim early-return is the only double-submit guard needed.
 *
 * `cd` is NOT special-cased here — it goes through the same POST path as
 * every other command. The server runs it inside the persistent shell that
 * backs the thread; when the shell's cwd drifts it emits a
 * `workingDirChanged` SSE event and the parent updates the folder picker.
 */
export function TerminalComposer({
  projectId,
  workingDir,
  onSent,
  initialInput,
  onChatEscape,
}: {
  projectId: string;
  workingDir: string;
  /** Optional hook the parent can use to flip a UX state on submit. */
  onSent?: (input: string) => void;
  /**
   * Optional seed value for the input. Read once at mount (standard
   * useState initial-value semantics) so changes after mount don't
   * clobber what the user has typed. Used by the chat → terminal
   * escape: when the user types `> ls` in the chat composer, the
   * parent flips compose mode and passes "ls" through here.
   */
  initialInput?: string;
  /**
   * Inverse of the chat composer's `onTerminalEscape`: when the user
   * starts a fresh terminal draft with `@` (the chat mention sigil),
   * hand control back to the chat composer with the typed content
   * carried over. Only fires on the FIRST transition out of an
   * essentially-empty input — pastes that start with `@` won't hijack.
   */
  onChatEscape?: (initialInput: string) => void;
}) {
  // Initial value: a queued launcher command for this project wins (and
  // is consumed); otherwise the chat→terminal escape seed. Read once at
  // mount (standard useState init) — the parent remounts via a `key`
  // bump to re-seed an already-mounted composer.
  const [seed] = useState(() => {
    const queued = pendingTerminalCommands.get(projectId);
    if (queued !== undefined) {
      pendingTerminalCommands.delete(projectId);
      return queued;
    }
    return initialInput ?? '';
  });
  const [error, setError] = useState<string | null>(null);
  // Which of the toolbar's three gallery popovers is open (null = none). One
  // slot rather than three booleans, so opening one closes the others. Each
  // reuses the right-rail CommandsPanel so the surfaces stay one implementation.
  const [openGallery, setOpenGallery] = useState<CommandsPanelSection | null>(null);
  const editorRef = useRef<TerminalCodeEditorHandle>(null);
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);

  // Drop a command chosen from the gallery into the editor for review —
  // the user still presses Enter to run it (the same "stage, don't fire"
  // contract as the right-rail launcher). Closing the popover returns
  // focus to the input via the Content's onCloseAutoFocus below, so a
  // just-staged command can be run without an extra click.
  const stageFromGallery = useCallback((command: string) => {
    editorRef.current?.setValue(command);
    setOpenGallery(null);
  }, []);

  // Fetch + cache the project's commands / craftbooks / tools and feed them to
  // the editor's (global, language-scoped) completion provider.
  useTerminalCompletionSources(projectId);

  const submit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed === '') return;
      // Clear + history-push optimistically so the user can immediately
      // type the next command while this one's still in flight.
      editorRef.current?.setValue('');
      setError(null);
      historyRef.current.unshift(trimmed);
      if (historyRef.current.length > 50) {
        historyRef.current.length = 50;
      }
      historyIdxRef.current = -1;
      try {
        await api.runTerminalCommand(projectId, { workingDir, input: trimmed });
        onSent?.(trimmed);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        // Belt-and-braces: if the error banner mounting drifted focus, snap it back.
        editorRef.current?.focus();
      }
    },
    [projectId, workingDir, onSent],
  );

  // Up at the first line: walk back through history.
  const historyPrev = useCallback(() => {
    if (historyRef.current.length === 0) return;
    const nextIdx = Math.min(historyRef.current.length - 1, historyIdxRef.current + 1);
    historyIdxRef.current = nextIdx;
    editorRef.current?.setValue(historyRef.current[nextIdx]!);
  }, []);

  // Down at the last line: walk forward, back to an empty draft past the newest.
  const historyNext = useCallback(() => {
    if (historyIdxRef.current < 0) return;
    const nextIdx = historyIdxRef.current - 1;
    historyIdxRef.current = nextIdx;
    editorRef.current?.setValue(nextIdx < 0 ? '' : historyRef.current[nextIdx]!);
  }, []);

  return (
    <div className="terminal-composer">
      {/* Toolbar — mirrors the squisq editor's top toolbar so the terminal
       * reads as a symmetric sibling of the chat editor. Holds the three
       * galleries (commands / scripts / tasks); picking from any of them
       * stages the line into the input for review. */}
      <div className="terminal-composer-toolbar">
        {GALLERIES.map((gallery) => (
          <Popover.Root
            key={gallery.section}
            open={openGallery === gallery.section}
            onOpenChange={(o) => setOpenGallery(o ? gallery.section : null)}
          >
            <Popover.Trigger asChild>
              <button
                type="button"
                className="terminal-toolbar-btn"
                title={gallery.title}
                aria-label={gallery.title}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  focusable="false"
                >
                  {gallery.icon}
                </svg>
                {gallery.label}
              </button>
            </Popover.Trigger>
            <Popover.Content
              className="terminal-commands-popover"
              side="top"
              align="start"
              onCloseAutoFocus={(e) => {
                // Keep focus on the terminal input rather than bouncing back
                // to the toolbar button, so a just-staged command can be run
                // with Enter straight away.
                e.preventDefault();
                editorRef.current?.focus();
              }}
            >
              <CommandsPanel
                projectId={projectId}
                section={gallery.section}
                onStageCommand={stageFromGallery}
              />
            </Popover.Content>
          </Popover.Root>
        ))}
      </div>
      <div className="terminal-composer-input-wrap">
        <span className="terminal-prompt-sigil">&gt;</span>
        <Suspense fallback={<div className="terminal-composer-input" aria-busy="true" />}>
          <TerminalCodeEditor
            ref={editorRef}
            projectId={projectId}
            initialValue={seed}
            placeholder={TERMINAL_PLACEHOLDER}
            onSubmit={(value) => void submit(value)}
            onHistoryPrev={historyPrev}
            onHistoryNext={historyNext}
            onChatEscape={onChatEscape}
          />
        </Suspense>
      </div>
      {error && <div className="terminal-error-banner">{error}</div>}
    </div>
  );
}
