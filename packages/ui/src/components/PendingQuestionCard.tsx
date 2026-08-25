import type {
  ClaudeUserQuestionIntent,
  NpmInstallApprovalDecision,
  NpmInstallApprovalPackage,
  Question,
  Task,
} from '@bendyline/gezel';
import { parseTaskRef } from '@bendyline/gezel';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { RenderedMarkdown } from './chat-bubbles.js';
import { navigateToTab } from './nav-actions.js';
import { questionChatTarget } from './question-nav.js';
import { toolDisplayName } from './tool-display.js';

type NpmDecision = NpmInstallApprovalDecision['decision'];

/**
 * Extract the package list from an `npm-install-approval` intent,
 * tolerating both the batch shape (`packages: []`) and the legacy
 * single-package shape (`package` + `version`). Legacy questions linger
 * on disk until the user clears them.
 */
function npmIntentPackages(question: Question): NpmInstallApprovalPackage[] {
  const intent = question.intent;
  if (!intent || intent.kind !== 'npm-install-approval') return [];
  const raw = intent as unknown as {
    packages?: NpmInstallApprovalPackage[];
    package?: string;
    version?: string;
  };
  if (Array.isArray(raw.packages) && raw.packages.length > 0) return raw.packages;
  if (typeof raw.package === 'string' && typeof raw.version === 'string') {
    return [{ package: raw.package, version: raw.version }];
  }
  return [];
}

/**
 * Set while the host has already lifted the attached document into its
 * own column (see {@link PendingQuestionCard}). {@link ContextStrip} then
 * renders the task row only — the document is on screen already, beside
 * the card rather than squeezed inside it.
 */
const DocumentHoisted = createContext(false);

/**
 * Interactive card for a structured question. Rendered:
 *   - inline below the assistant bubble that asked it (chat-bubbles.tsx)
 *   - in the Home "Needs your input" panel (HomeView)
 *
 * Same component, same answer flow either way. When the underlying
 * `question` arrives with `answer` set, the card auto-collapses to the
 * read-only "Answered" form.
 *
 * A question that carries a document (a night-shift report, a plan) gets
 * a two-column layout: the card on the left, the document as a tall
 * portrait panel on the right that scrolls on its own. Answered cards
 * collapse to a single line, so they keep the plain one-column shape —
 * a full-height document panel next to one sentence reads as broken.
 */
export function PendingQuestionCard(props: {
  question: Question;
  /** Called after a successful submit/skip — parent can refresh lists. */
  onAnswered?: (q: Question) => void;
  /**
   * Optional "Open in chat" link target. The chat-bubble surface
   * doesn't pass this (we're already in chat); the Home pane does.
   */
  onOpenInChat?: (question: Question) => void;
}) {
  const { question } = props;
  const body = <QuestionBody {...props} />;
  if (question.answer || !question.documentPath) return body;
  return (
    <div className="pending-question-splitwrap">
      <div className="pending-question-split">
        <div className="pending-question-split-main">
          <DocumentHoisted.Provider value={true}>{body}</DocumentHoisted.Provider>
        </div>
        <DocumentContext
          projectId={question.projectId}
          documentPath={question.documentPath}
          layout="panel"
        />
      </div>
    </div>
  );
}

function QuestionBody({
  question,
  onAnswered,
  onOpenInChat,
}: {
  question: Question;
  onAnswered?: (q: Question) => void;
  onOpenInChat?: (question: Question) => void;
}) {
  if (question.answer) {
    return <AnsweredView question={question} />;
  }
  if (question.intent?.kind === 'npm-install-approval') {
    return (
      <NpmInstallApprovalForm
        question={question}
        onAnswered={onAnswered}
        onOpenInChat={onOpenInChat}
      />
    );
  }
  if (question.intent?.kind === 'tool-permission') {
    return (
      <ToolPermissionForm question={question} onAnswered={onAnswered} onOpenInChat={onOpenInChat} />
    );
  }
  if (question.intent?.kind === 'claude-user-question') {
    return (
      <ClaudeUserQuestionForm
        question={question}
        onAnswered={onAnswered}
        onOpenInChat={onOpenInChat}
      />
    );
  }
  if (question.intent?.kind === 'toolset-install-approval') {
    return (
      <ToolsetInstallApprovalForm
        question={question}
        onAnswered={onAnswered}
        onOpenInChat={onOpenInChat}
      />
    );
  }
  if (question.intent?.kind === 'image-generation-approval') {
    return (
      <ImageGenerationApprovalForm
        question={question}
        onAnswered={onAnswered}
        onOpenInChat={onOpenInChat}
      />
    );
  }
  if (question.intent?.kind === 'schedule-approval') {
    return (
      <ScheduleApprovalForm
        question={question}
        onAnswered={onAnswered}
        onOpenInChat={onOpenInChat}
      />
    );
  }
  if (question.intent?.kind === 'night-shift-review') {
    return <NightShiftReviewCard question={question} onAnswered={onAnswered} />;
  }
  if (question.intent?.kind === 'task-paused') {
    return <TaskPausedCard question={question} onAnswered={onAnswered} />;
  }
  return <PendingForm question={question} onAnswered={onAnswered} onOpenInChat={onOpenInChat} />;
}

/**
 * "Open in chat" — renders only when the host wants the affordance AND the
 * question actually points at a thread. Service-synthesized cards carry no
 * session (see `questionChatTarget`), and a button that navigates nowhere
 * reads as broken rather than as "there's nothing here."
 */
function OpenInChatButton({
  question,
  onOpenInChat,
  disabled,
}: {
  question: Question;
  onOpenInChat?: (question: Question) => void;
  disabled?: boolean;
}) {
  if (!onOpenInChat || !questionChatTarget(question)) return null;
  return (
    <button
      type="button"
      className="pending-question-open subtle"
      onClick={() => onOpenInChat(question)}
      disabled={disabled}
    >
      Open in chat
    </button>
  );
}

// ── Night-shift review (the morning summary) ───────────────────────
//
// Synthesized once per settled night window: what the shift finished
// and which reports carry suggested actions. Report rows open the
// owning project; Dismiss collapses the card (the answer route
// early-returns — nothing to arm or seed).

function NightShiftReviewCard({
  question,
  onAnswered,
}: {
  question: Question;
  onAnswered?: (q: Question) => void;
}) {
  const intent = question.intent as {
    kind: 'night-shift-review';
    windowKey: string;
    tasksCompleted: number;
    reports: Array<{ projectId: string; path: string; title?: string; actionCount: number }>;
  };
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dismiss = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await api.answerQuestion(question.id, { selectedChoices: [0] });
      onAnswered?.(updated);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to dismiss.');
      setSubmitting(false);
    }
  }, [question.id, submitting, onAnswered]);

  return (
    <div className="pending-question pending-question-pending pending-question-night-review">
      <ContextStrip question={question} />
      <div className="pending-question-prompt">{question.prompt}</div>
      {intent.reports.length > 0 && (
        <div className="pending-question-night-reports">
          {intent.reports.map((r) => (
            <button
              key={`${r.projectId}:${r.path}`}
              type="button"
              className="pending-question-night-report"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('gezel:open-tab', {
                    detail: { kind: 'project', id: r.projectId, activate: true },
                  }),
                )
              }
            >
              <span>{r.title ?? r.path}</span>
              {r.actionCount > 0 && (
                <span className="muted small">
                  {r.actionCount} action{r.actionCount === 1 ? '' : 's'}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {error && <p className="pending-question-error">{error}</p>}
      <div className="pending-question-actions">
        <button
          type="button"
          className="pending-question-skip subtle"
          onClick={() => void dismiss()}
          disabled={submitting}
        >
          {submitting ? 'Saving…' : 'Dismiss'}
        </button>
      </div>
    </div>
  );
}

// ── Task paused for help ────────────────────────────────────────────
//
// A background task that hit a wall files this card (gate budget spent,
// plateau, stalled step, spent task budget, a gate that couldn't run).
// Dismissing it only collapses the card — the task stays paused — so the
// card also carries the one move that gets the work going again:
// "Try again" resets the recovery counters that tripped the pause, flips
// the task active, and re-drives the assignee. Whether a second attempt
// can succeed is the user's call: some pauses (a craftbook gate pinned on
// a parameter that was never supplied) need an edit first, and the button
// is there for the person who just made it.

function TaskPausedCard({
  question,
  onAnswered,
}: {
  question: Question;
  onAnswered?: (q: Question) => void;
}) {
  const [submitting, setSubmitting] = useState<'retry' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);

  const dismiss = useCallback(async () => {
    if (submitting) return;
    setSubmitting('dismiss');
    setError(null);
    try {
      const updated = await api.answerQuestion(question.id, { selectedChoices: [0] });
      onAnswered?.(updated);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to dismiss.');
      setSubmitting(null);
    }
  }, [question.id, submitting, onAnswered]);

  const retry = useCallback(async () => {
    if (submitting) return;
    const ref = question.taskRef ? parseTaskRef(question.taskRef) : null;
    if (!ref) {
      setError("This card doesn't name a task to retry.");
      return;
    }
    setSubmitting('retry');
    setError(null);
    setHeld(null);
    try {
      const result = await api.retryTask(ref.projectId, ref.num);
      // A hold that the user can act on keeps the card open with the
      // explanation; anything else means the task is moving (or was
      // already), so the card has done its job.
      const blocking =
        result.reason === 'no-active-step' ||
        result.reason === 'no-assignee' ||
        result.reason === 'project-inactive'
          ? result.reason
          : null;
      if (blocking) {
        setHeld(retryHoldText(blocking));
        setSubmitting(null);
        return;
      }
      const updated = await api.answerQuestion(question.id, { selectedChoices: [0] });
      onAnswered?.(updated);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to restart the task.');
      setSubmitting(null);
    }
  }, [question.id, question.taskRef, submitting, onAnswered]);

  return (
    <div className="pending-question pending-question-pending">
      <ContextStrip question={question} />
      <div className="pending-question-prompt">
        <RenderedMarkdown markdown={question.prompt} />
      </div>
      {held && <p className="pending-question-hold muted">{held}</p>}
      {error && <p className="pending-question-error">{error}</p>}
      <div className="pending-question-actions">
        <button
          type="button"
          className="pending-question-submit"
          onClick={() => void retry()}
          disabled={submitting !== null || !question.taskRef}
        >
          {submitting === 'retry' ? 'Restarting…' : 'Try again'}
        </button>
        <button
          type="button"
          className="pending-question-skip subtle"
          onClick={() => void dismiss()}
          disabled={submitting !== null}
        >
          {submitting === 'dismiss' ? 'Saving…' : 'Dismiss'}
        </button>
      </div>
    </div>
  );
}

/** Why the retry didn't put anyone back to work, in the user's terms. */
function retryHoldText(reason: 'no-active-step' | 'no-assignee' | 'project-inactive'): string {
  switch (reason) {
    case 'no-active-step':
      return 'The task is active again, but no step is current — open it and start one.';
    case 'no-assignee':
      return 'The task is active again, but its current step has nobody assigned — open it and pick a gezel.';
    case 'project-inactive':
      return "The task is active again, but this project isn't taking background work right now. Set it active in the project's settings.";
  }
}

// ── Image generation approval (cloud provider cost gate) ───────────
//
// The service synthesizes a question with intent
// `image-generation-approval` before each cloud `generate_image` call
// when `config.imageGenerationConfirmation` is `'ask'`, then long-polls
// the question file. Three buttons: Allow once / Always allow /
// Decline. "Always allow" flips the config so future cloud generations
// don't prompt.

function ImageGenerationApprovalForm({
  question,
  onAnswered,
  onOpenInChat,
}: {
  question: Question;
  onAnswered?: (q: Question) => void;
  onOpenInChat?: (question: Question) => void;
}) {
  const intent = question.intent as {
    kind: 'image-generation-approval';
    provider: string;
    model: string;
    promptPreview: string;
    estimatedSize?: string;
  };
  const [submitting, setSubmitting] = useState<'allow' | 'always' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (decision: 'allow' | 'always' | 'decline') => {
      if (submitting) return;
      setSubmitting(decision);
      setError(null);
      try {
        const choice = decision === 'allow' ? 0 : decision === 'always' ? 1 : 2;
        const flipConfig = decision === 'always';
        if (flipConfig) {
          await api.updateConfig({ imageGenerationConfirmation: 'always-allow' });
        }
        const updated = await api.answerQuestion(question.id, {
          selectedChoices: [choice],
          ...(decision === 'decline' ? { declined: true } : {}),
        });
        onAnswered?.(updated);
      } catch (err) {
        setError((err as Error).message ?? 'Failed to submit answer.');
        setSubmitting(null);
      }
    },
    [question.id, submitting, onAnswered],
  );

  const providerLabel =
    intent.provider === 'google-ai'
      ? 'Google Nano Banana'
      : intent.provider === 'openai'
        ? 'OpenAI GPT Image'
        : intent.provider;

  return (
    <div className="pending-question pending-question-pending pending-question-image-approval">
      <ContextStrip question={question} />
      <div className="pending-question-prompt">
        <strong>{providerLabel}</strong> wants to generate an image (model{' '}
        <code>{intent.model}</code>
        {intent.estimatedSize ? `, ${intent.estimatedSize}` : ''}). Use a credit?
      </div>
      <details className="pending-question-tool-args" open>
        <summary>Prompt</summary>
        <blockquote className="pending-question-image-prompt">{intent.promptPreview}</blockquote>
      </details>
      {error && <p className="pending-question-error">{error}</p>}
      <div className="pending-question-actions">
        <button
          type="button"
          className="pending-question-submit"
          onClick={() => void submit('allow')}
          disabled={submitting !== null}
        >
          {submitting === 'allow' ? 'Allowing…' : 'Allow once'}
        </button>
        <button
          type="button"
          className="pending-question-submit subtle"
          onClick={() => void submit('always')}
          disabled={submitting !== null}
        >
          {submitting === 'always' ? 'Saving…' : 'Always allow'}
        </button>
        <button
          type="button"
          className="pending-question-skip subtle"
          onClick={() => void submit('decline')}
          disabled={submitting !== null}
        >
          {submitting === 'decline' ? 'Declining…' : 'Decline'}
        </button>
        <OpenInChatButton question={question} onOpenInChat={onOpenInChat} />
      </div>
    </div>
  );
}

// ── Schedule approval (project-type adoption consent) ──────────────
//
// A project type that declares a schedule with `consent: 'ask'` creates
// its cron host task PAUSED and posts a question with intent
// `schedule-approval` — never silently armed. Enabling arms the host
// (the answer route re-derives the next fire time from now); keeping it
// paused leaves the Tasks view as the manual enable path.

function ScheduleApprovalForm({
  question,
  onAnswered,
  onOpenInChat,
}: {
  question: Question;
  onAnswered?: (q: Question) => void;
  onOpenInChat?: (question: Question) => void;
}) {
  const intent = question.intent as {
    kind: 'schedule-approval';
    typeId: string;
    craftbookId: string;
    runMode?: 'scheduled' | 'night-shift';
    cron: string;
    overlap?: string;
  };
  const nightShift = intent.runMode === 'night-shift';
  const [submitting, setSubmitting] = useState<'enable' | 'keep' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (decision: 'enable' | 'keep') => {
      if (submitting) return;
      setSubmitting(decision);
      setError(null);
      try {
        const updated = await api.answerQuestion(question.id, {
          selectedChoices: [decision === 'enable' ? 0 : 1],
          ...(decision === 'keep' ? { declined: true } : {}),
        });
        onAnswered?.(updated);
      } catch (err) {
        setError((err as Error).message ?? 'Failed to submit answer.');
        setSubmitting(null);
      }
    },
    [question.id, submitting, onAnswered],
  );

  return (
    <div className="pending-question pending-question-pending pending-question-schedule-approval">
      <ContextStrip question={question} />
      <div className="pending-question-prompt">
        {nightShift ? (
          <>
            The <strong>{intent.typeId}</strong> project type set up a recurring{' '}
            <strong>{intent.craftbookId}</strong> run for the Night Shift (at most once per night,
            inside your configured window). It stays paused until you enable it.
          </>
        ) : (
          <>
            The <strong>{intent.typeId}</strong> project type set up a recurring{' '}
            <strong>{intent.craftbookId}</strong> run (<code>{intent.cron}</code> UTC
            {intent.overlap ? `, overlap: ${intent.overlap}` : ''}). It stays paused until you
            enable it.
          </>
        )}
      </div>
      {error && <p className="pending-question-error">{error}</p>}
      <div className="pending-question-actions">
        <button
          type="button"
          className="pending-question-submit"
          onClick={() => void submit('enable')}
          disabled={submitting !== null}
        >
          {submitting === 'enable' ? 'Enabling…' : 'Enable schedule'}
        </button>
        <button
          type="button"
          className="pending-question-skip subtle"
          onClick={() => void submit('keep')}
          disabled={submitting !== null}
        >
          {submitting === 'keep' ? 'Saving…' : 'Keep paused'}
        </button>
        <OpenInChatButton question={question} onOpenInChat={onOpenInChat} />
      </div>
    </div>
  );
}

// ── Tool permission (Claude CLI provider) ──────────────────────────
//
// The Claude CLI provider's `--permission-prompt-tool` hook routes through
// gezel-mcp → POST /api/permissions/request-and-wait, which posts a
// question with intent `tool-permission` and blocks the HTTP response
// until the user answers Allow / Deny here. The polling endpoint reads
// the persisted answer and returns the verdict to Claude CLI, which
// either runs the tool or feeds a deny message back to the model.

function ToolPermissionForm({
  question,
  onAnswered,
  onOpenInChat,
}: {
  question: Question;
  onAnswered?: (q: Question) => void;
  onOpenInChat?: (question: Question) => void;
}) {
  const intent = question.intent as {
    kind: 'tool-permission';
    toolName: string;
    toolInput: Record<string, unknown>;
  };
  const [submitting, setSubmitting] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (decision: 'allow' | 'deny') => {
      if (submitting) return;
      setSubmitting(decision);
      setError(null);
      try {
        const updated = await api.answerQuestion(question.id, {
          selectedChoices: [decision === 'allow' ? 0 : 1],
        });
        onAnswered?.(updated);
      } catch (err) {
        setError((err as Error).message ?? 'Failed to submit answer.');
        setSubmitting(null);
      }
    },
    [question.id, submitting, onAnswered],
  );

  const argsPretty = useMemo(() => {
    try {
      return JSON.stringify(intent.toolInput, null, 2);
    } catch {
      return '<<unserializable>>';
    }
  }, [intent.toolInput]);

  return (
    <div className="pending-question pending-question-pending pending-question-tool-permission">
      <ContextStrip question={question} />
      <div className="pending-question-prompt">
        {/* The raw slug rides along as the title so a power user can still
            see which tool this is without it being the headline. */}
        Your gezel wants to use the{' '}
        <strong title={intent.toolName}>{toolDisplayName(intent.toolName)}</strong> tool.
      </div>
      {Object.keys(intent.toolInput).length > 0 && (
        <details className="pending-question-tool-args" open>
          <summary>Arguments</summary>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: this overflow viewport must be keyboard-scrollable. */}
          <pre tabIndex={0}>
            <code>{argsPretty}</code>
          </pre>
        </details>
      )}
      {error && <p className="pending-question-error">{error}</p>}
      <div className="pending-question-actions">
        <button
          type="button"
          className="pending-question-submit"
          onClick={() => void submit('allow')}
          disabled={submitting !== null}
        >
          {submitting === 'allow' ? 'Allowing…' : 'Allow'}
        </button>
        <button
          type="button"
          className="pending-question-skip subtle"
          onClick={() => void submit('deny')}
          disabled={submitting !== null}
        >
          {submitting === 'deny' ? 'Denying…' : 'Deny'}
        </button>
        <OpenInChatButton question={question} onOpenInChat={onOpenInChat} />
      </div>
    </div>
  );
}

// ── Craftbook toolset install approval ─────────────────────────────
//
// A craftbook can auto-install only the exact trusted constrained
// dependencies. Other zero-configuration MCP toolsets pause the live
// invocation here so the user explicitly approves the download/register
// step; the service resumes that same invocation after this answer lands.

function ToolsetInstallApprovalForm({
  question,
  onAnswered,
  onOpenInChat,
}: {
  question: Question;
  onAnswered?: (q: Question) => void;
  onOpenInChat?: (question: Question) => void;
}) {
  const intent = question.intent as {
    kind: 'toolset-install-approval';
    toolsetId: string;
    sourceId: string;
    version: string;
    targetProjectId: string;
    craftbookId: string;
  };
  const [submitting, setSubmitting] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (decision: 'allow' | 'deny') => {
      if (submitting) return;
      setSubmitting(decision);
      setError(null);
      try {
        const updated = await api.answerQuestion(question.id, {
          selectedChoices: [decision === 'allow' ? 0 : 1],
        });
        onAnswered?.(updated);
      } catch (err) {
        setError((err as Error).message ?? 'Failed to submit answer.');
        setSubmitting(null);
      }
    },
    [question.id, submitting, onAnswered],
  );

  return (
    <div className="pending-question pending-question-pending pending-question-tool-permission">
      <ContextStrip question={question} />
      <div className="pending-question-prompt">{question.prompt}</div>
      <details className="pending-question-tool-args">
        <summary>Install details</summary>
        <dl>
          <dt>Toolset</dt>
          <dd>
            <code>{intent.toolsetId}</code>
          </dd>
          <dt>Version</dt>
          <dd>{intent.version}</dd>
          <dt>Project</dt>
          <dd>{intent.targetProjectId}</dd>
          <dt>Requested by</dt>
          <dd>{intent.craftbookId}</dd>
        </dl>
      </details>
      {error && <p className="pending-question-error">{error}</p>}
      <div className="pending-question-actions">
        <button
          type="button"
          className="pending-question-submit"
          onClick={() => void submit('allow')}
          disabled={submitting !== null}
        >
          {submitting === 'allow' ? 'Installing…' : 'Install'}
        </button>
        <button
          type="button"
          className="pending-question-skip subtle"
          onClick={() => void submit('deny')}
          disabled={submitting !== null}
        >
          {submitting === 'deny' ? 'Declining…' : 'Not now'}
        </button>
        <OpenInChatButton question={question} onOpenInChat={onOpenInChat} />
      </div>
    </div>
  );
}

// ── Answered (read-only collapsed) ──────────────────────────────────

function AnsweredView({ question }: { question: Question }) {
  const ans = question.answer;
  if (!ans) return null;
  if (ans.silentSkip) {
    return (
      <div className="pending-question pending-question-answered">
        <span className="pending-question-label muted">Question</span>
        <span className="pending-question-summary">Skipped: {oneLine(question.prompt, 100)}</span>
      </div>
    );
  }
  if (ans.declined) {
    return (
      <div className="pending-question pending-question-answered">
        <span className="pending-question-label muted">Question</span>
        <span className="pending-question-summary">
          Proceed with defaults: {oneLine(question.prompt, 100)}
        </span>
      </div>
    );
  }
  if (ans.npmInstallDecisions && ans.npmInstallDecisions.length > 0) {
    const counts = ans.npmInstallDecisions.reduce<Record<NpmDecision, number>>(
      (acc, d) => {
        acc[d.decision] = (acc[d.decision] ?? 0) + 1;
        return acc;
      },
      { install: 0, always: 0, decline: 0 },
    );
    const parts: string[] = [];
    if (counts.install) parts.push(`${counts.install} installed`);
    if (counts.always) parts.push(`${counts.always} always-allowed`);
    if (counts.decline) parts.push(`${counts.decline} declined`);
    return (
      <div className="pending-question pending-question-answered">
        <span className="pending-question-label muted">Answered</span>
        <span className="pending-question-summary">{parts.join(', ')}</span>
      </div>
    );
  }
  const choices = (ans.selectedChoices ?? [])
    .map((i) => question.choices?.[i])
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  return (
    <div className="pending-question pending-question-answered">
      <span className="pending-question-label muted">Answered</span>
      <span className="pending-question-summary">
        {choices.length > 0 && <strong>{choices.join(', ')}</strong>}
        {choices.length > 0 && ans.writeIn ? ' · ' : ''}
        {ans.writeIn ?? ''}
      </span>
    </div>
  );
}

// ── Pending (interactive form) ──────────────────────────────────────

// ── Claude CLI AskUserQuestion (answered via the permission broker) ─
//
// The service's permission route intercepts Claude's native
// AskUserQuestion tool and re-shapes each entry into a real question
// card: the intent carries what the plain Question can't hold — option
// descriptions, the CLI's short header chip, and the position within a
// multi-question call. The answer flows back to the still-running
// `claude` subprocess as `updatedInput.answers`, so the dismiss hints
// differ from a plain question's: the gezel is mid-turn and continues
// either way.

function ClaudeUserQuestionForm({
  question,
  onAnswered,
  onOpenInChat,
}: {
  question: Question;
  onAnswered?: (q: Question) => void;
  onOpenInChat?: (question: Question) => void;
}) {
  const intent = question.intent as ClaudeUserQuestionIntent;
  const kicker = [
    intent.header,
    intent.questionCount > 1
      ? `question ${intent.questionIndex + 1} of ${intent.questionCount}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <PendingForm
      question={question}
      onAnswered={onAnswered}
      onOpenInChat={onOpenInChat}
      kicker={kicker || undefined}
      choiceDescriptions={intent.options.map((o) => o.description)}
      skipHint="Dismiss without answering. The gezel is still working and will carry on without this input."
      justDoHint="Tell the gezel to decide on its own, using sensible defaults."
    />
  );
}

function PendingForm({
  question,
  onAnswered,
  onOpenInChat,
  kicker,
  choiceDescriptions,
  skipHint,
  justDoHint,
}: {
  question: Question;
  onAnswered?: (q: Question) => void;
  onOpenInChat?: (question: Question) => void;
  /** Small muted line above the prompt (header chip, "question 2 of 3"). */
  kicker?: string;
  /** Per-choice description lines, index-aligned with `question.choices`. */
  choiceDescriptions?: (string | undefined)[];
  skipHint?: string;
  justDoHint?: string;
}) {
  const allowWriteIn = question.allowWriteIn ?? true;
  const multi = question.multiSelect ?? false;
  const choices = question.choices ?? [];
  // Single-select with no write-in (e.g. Approve/Decline command-approval
  // gates): clicking a choice IS the answer — no Submit/Skip/Just-do-whatever
  // row needed. Multi-select still needs explicit confirmation, and
  // write-in mode needs the row so the user can type without committing.
  const autoSubmit = !multi && !allowWriteIn && choices.length > 0;
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [writeIn, setWriteIn] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Auto-submit mode tracks which choice is mid-flight so we can label
  // it ("Approving…") while disabling the rest.
  const [autoSubmittingIdx, setAutoSubmittingIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleChoice = useCallback(
    (idx: number) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (multi) {
          if (next.has(idx)) next.delete(idx);
          else next.add(idx);
        } else {
          next.clear();
          next.add(idx);
        }
        return next;
      });
    },
    [multi],
  );

  const submit = useCallback(
    async (mode: 'submit' | 'just-do-whatever' | 'silent-skip') => {
      if (submitting) return;
      const selectedChoices = Array.from(selected).sort((a, b) => a - b);
      // Block empty submits unless dismissing via Skip / Just do whatever.
      if (mode === 'submit' && selectedChoices.length === 0 && !writeIn.trim()) {
        setError("Pick a choice or type something — or use Skip if you'd rather not answer.");
        return;
      }
      setError(null);
      setSubmitting(true);
      try {
        const updated = await api.answerQuestion(question.id, {
          ...(mode === 'submit' && selectedChoices.length > 0 ? { selectedChoices } : {}),
          ...(mode === 'submit' && writeIn.trim() ? { writeIn: writeIn.trim() } : {}),
          ...(mode === 'just-do-whatever' ? { declined: true } : {}),
          ...(mode === 'silent-skip' ? { silentSkip: true } : {}),
        });
        onAnswered?.(updated);
      } catch (err) {
        setError((err as Error).message ?? 'Failed to submit answer.');
        setSubmitting(false);
      }
    },
    [question.id, selected, writeIn, submitting, onAnswered],
  );

  // Auto-submit handler: submits with a single explicit choice index,
  // bypassing the `selected` state (which is async to set). Used by the
  // simple-form path where clicking a choice is the answer.
  const submitChoice = useCallback(
    async (idx: number) => {
      if (autoSubmittingIdx !== null) return;
      setAutoSubmittingIdx(idx);
      setError(null);
      try {
        const updated = await api.answerQuestion(question.id, {
          selectedChoices: [idx],
        });
        onAnswered?.(updated);
      } catch (err) {
        setError((err as Error).message ?? 'Failed to submit answer.');
        setAutoSubmittingIdx(null);
      }
    },
    [question.id, autoSubmittingIdx, onAnswered],
  );

  return (
    <div className="pending-question pending-question-pending">
      <ContextStrip question={question} />
      {kicker && <span className="pending-question-label muted">{kicker}</span>}
      <div className="pending-question-prompt">
        <RenderedMarkdown markdown={question.prompt} />
      </div>
      {choices.length > 0 && (
        <div
          className={`pending-question-choices${multi ? ' is-multi' : ''}`}
          role={multi ? 'group' : 'radiogroup'}
        >
          {choices.map((choice, i) =>
            autoSubmit ? (
              <button
                key={choice}
                type="button"
                className="pending-question-choice pending-question-choice-auto"
                onClick={() => void submitChoice(i)}
                disabled={autoSubmittingIdx !== null}
                aria-busy={autoSubmittingIdx === i}
              >
                {autoSubmittingIdx === i ? `${choice}…` : choice}
              </button>
            ) : (
              <button
                key={choice}
                type="button"
                className={`pending-question-choice${selected.has(i) ? ' is-selected' : ''}${choiceDescriptions?.[i] ? ' pending-question-choice-described' : ''}`}
                onClick={() => toggleChoice(i)}
                aria-pressed={selected.has(i)}
              >
                {choiceDescriptions?.[i] ? (
                  <>
                    <span className="pending-question-choice-title">{choice}</span>
                    <span className="pending-question-choice-desc">{choiceDescriptions[i]}</span>
                  </>
                ) : (
                  choice
                )}
              </button>
            ),
          )}
        </div>
      )}
      {allowWriteIn && (
        <textarea
          className="pending-question-write-in"
          placeholder={choices.length > 0 ? 'Add a note (optional)…' : 'Type your answer…'}
          rows={2}
          value={writeIn}
          onChange={(e) => setWriteIn(e.target.value)}
          disabled={submitting}
        />
      )}
      {error && <p className="pending-question-error">{error}</p>}
      <div className="pending-question-actions">
        {!autoSubmit && (
          <>
            <button
              type="button"
              className="pending-question-submit"
              onClick={() => void submit('submit')}
              disabled={submitting}
            >
              {submitting ? 'Submitting…' : 'Submit'}
            </button>
            <button
              type="button"
              className="pending-question-skip subtle"
              onClick={() => void submit('silent-skip')}
              disabled={submitting}
              title={
                skipHint ??
                'Dismiss the question. The gezel keeps doing nothing — its turn already ended.'
              }
            >
              Skip
            </button>
            <button
              type="button"
              className="pending-question-skip subtle"
              onClick={() => void submit('just-do-whatever')}
              disabled={submitting}
              title={
                justDoHint ??
                'Tell the gezel to proceed without your input, using sensible defaults.'
              }
            >
              Just do whatever
            </button>
          </>
        )}
        <OpenInChatButton
          question={question}
          onOpenInChat={onOpenInChat}
          disabled={autoSubmittingIdx !== null}
        />
      </div>
    </div>
  );
}

// ── npm-install approval (per-package decisions) ───────────────────

function NpmInstallApprovalForm({
  question,
  onAnswered,
  onOpenInChat,
}: {
  question: Question;
  onAnswered?: (q: Question) => void;
  onOpenInChat?: (question: Question) => void;
}) {
  const packages = useMemo(() => npmIntentPackages(question), [question]);
  const [decisions, setDecisions] = useState<NpmDecision[]>(() =>
    packages.map(() => 'install' as const),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setOne = useCallback((idx: number, decision: NpmDecision) => {
    setDecisions((prev) => {
      const next = prev.slice();
      next[idx] = decision;
      return next;
    });
  }, []);

  const setAll = useCallback(
    (decision: NpmDecision) => {
      setDecisions(packages.map(() => decision));
    },
    [packages],
  );

  const submit = useCallback(
    async (declined: boolean) => {
      if (submitting) return;
      setError(null);
      setSubmitting(true);
      try {
        const body = declined
          ? { declined: true as const }
          : {
              npmInstallDecisions: packages.map((p, i) => ({
                package: p.package,
                version: p.version,
                decision: decisions[i] ?? 'decline',
              })),
            };
        const updated = await api.answerQuestion(question.id, body);
        onAnswered?.(updated);
      } catch (err) {
        setError((err as Error).message ?? 'Failed to submit answer.');
        setSubmitting(false);
      }
    },
    [packages, decisions, question.id, submitting, onAnswered],
  );

  if (packages.length === 0) {
    return (
      <div className="pending-question pending-question-pending">
        <p className="pending-question-error">Approval has no packages. Skip it.</p>
        <div className="pending-question-actions">
          <button
            type="button"
            className="pending-question-skip subtle"
            onClick={() => void submit(true)}
            disabled={submitting}
          >
            Skip
          </button>
        </div>
      </div>
    );
  }

  const multi = packages.length > 1;
  return (
    <div className="pending-question pending-question-pending pending-question-npm">
      <div className="pending-question-prompt">
        {multi ? (
          <p>
            A gezel wants to install <strong>{packages.length} npm packages</strong> — not in the
            pre-vetted list. Pick one per package, or apply the same to all:
          </p>
        ) : (
          <p>A gezel wants to install an npm package — not in the pre-vetted list. Approve?</p>
        )}
      </div>

      {multi && (
        <div className="pending-question-npm-bulk">
          <span className="muted small">Set all:</span>
          <button type="button" className="subtle" onClick={() => setAll('install')}>
            Install all
          </button>
          <button type="button" className="subtle" onClick={() => setAll('always')}>
            Always allow all
          </button>
          <button type="button" className="subtle" onClick={() => setAll('decline')}>
            Decline all
          </button>
        </div>
      )}

      <ul className="pending-question-npm-list">
        {packages.map((p, i) => (
          <li key={`${p.package}@${p.version}`} className="pending-question-npm-row">
            <div className="pending-question-npm-identity">
              <span className="pending-question-npm-chip">npm install</span>
              <span className="pending-question-context-title">
                <code>{p.package}</code>@<code>{p.version}</code>
              </span>
              <a
                className="pending-question-context-link"
                href={`https://www.npmjs.com/package/${encodeURIComponent(p.package)}`}
                target="_blank"
                rel="noreferrer"
              >
                View on npm ↗
              </a>
            </div>
            <div className="pending-question-npm-choice" role="radiogroup">
              {(
                [
                  { value: 'install', label: 'Install' },
                  { value: 'always', label: 'Always allow' },
                  { value: 'decline', label: 'Decline' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: styled button-radio pattern — a native <input type=radio> can't carry this visual shape.
                  role="radio"
                  aria-checked={decisions[i] === opt.value}
                  className={`pending-question-choice${
                    decisions[i] === opt.value ? ' is-selected' : ''
                  }`}
                  onClick={() => setOne(i, opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>

      {error && <p className="pending-question-error">{error}</p>}
      <div className="pending-question-actions">
        <button
          type="button"
          className="pending-question-submit"
          onClick={() => void submit(false)}
          disabled={submitting}
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
        <button
          type="button"
          className="pending-question-skip subtle"
          onClick={() => void submit(true)}
          disabled={submitting}
        >
          Skip
        </button>
        <OpenInChatButton question={question} onOpenInChat={onOpenInChat} />
      </div>
    </div>
  );
}

// ── Context strip (task / document attachments) ─────────────────────

function ContextStrip({ question }: { question: Question }) {
  const documentHoisted = useContext(DocumentHoisted);
  const showDocument = Boolean(question.documentPath) && !documentHoisted;
  if (!question.taskRef && !showDocument) return null;
  return (
    <div className="pending-question-context">
      {question.taskRef && <TaskContext taskRef={question.taskRef} />}
      {showDocument && question.documentPath && (
        <DocumentContext projectId={question.projectId} documentPath={question.documentPath} />
      )}
    </div>
  );
}

function TaskContext({ taskRef }: { taskRef: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTask(null);
    setError(null);
    api
      .getTaskByRef(taskRef)
      .then((t) => {
        if (!cancelled) setTask(t);
      })
      .catch((err) => {
        if (cancelled) return;
        const raw = (err as Error).message;
        const friendly = /404/.test(raw)
          ? `doesn't exist — the gezel referenced a task that hasn't been created`
          : `couldn't load: ${raw}`;
        setError(friendly);
      });
    return () => {
      cancelled = true;
    };
  }, [taskRef]);
  if (error) {
    return (
      <div className="pending-question-context-row">
        <span className="muted">
          Task {taskRef} ({error})
        </span>
      </div>
    );
  }
  if (!task) {
    return (
      <div className="pending-question-context-row">
        <span className="muted">Task {taskRef} (loading…)</span>
      </div>
    );
  }
  return (
    <div className="pending-question-context-row">
      <span className="muted">Task</span>
      <span className="pending-question-context-title">{task.title}</span>
      <span className={`pending-question-context-status status-${task.status}`}>{task.status}</span>
      <button
        type="button"
        className="pending-question-context-link"
        onClick={() => navigateToTab({ kind: 'task', ref: taskRef })}
      >
        Open task
      </button>
    </div>
  );
}

function DocumentContext({
  projectId,
  documentPath,
  layout = 'inline',
}: {
  projectId: string;
  documentPath: string;
  /**
   * `inline` sits inside the card's context strip and shows a ten-line
   * teaser with an expand toggle. `panel` is the hoisted right-hand
   * column: the whole document, scrolling in place, no toggle.
   */
  layout?: 'inline' | 'panel';
}) {
  const panel = layout === 'panel';
  const [content, setContent] = useState<string | null>(null);
  const [resolvedKind, setResolvedKind] = useState<
    'document' | 'project-document' | 'artifact' | null
  >(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Project-relative paths get the project prefix; bare paths are
  // treated as global library (matches readDocument's contract).
  const fullPath = useMemo(
    () =>
      projectId && projectId !== 'default' && !documentPath.startsWith('projects/')
        ? `projects/${projectId}/${documentPath}`
        : documentPath,
    [projectId, documentPath],
  );
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setResolvedKind(null);
    setError(null);
    api
      .readDocument(fullPath)
      .then((res) => {
        if (cancelled) return;
        setContent(res.content);
        setResolvedKind(res.kind ?? 'document');
      })
      .catch((err) => {
        if (cancelled) return;
        const raw = (err as Error).message;
        // The model can reference a path that doesn't exist in
        // documents, per-project docs, OR artifacts (the server's
        // fuzzy fallback already tried all three). Collapse the API
        // error into something human — the user shouldn't see our
        // internal URL shape.
        const friendly = /404/.test(raw)
          ? `No document, project doc, or artifact at ${documentPath} — the gezel referenced a path that doesn't exist yet.`
          : raw;
        setError(friendly);
      });
    return () => {
      cancelled = true;
    };
  }, [fullPath, documentPath]);

  const previewLines = useMemo(() => {
    if (!content) return '';
    if (panel) return content;
    const lines = content.split('\n');
    return expanded ? content : lines.slice(0, 10).join('\n');
  }, [content, expanded, panel]);

  const kindLabel =
    resolvedKind === 'artifact'
      ? 'Artifact'
      : resolvedKind === 'project-document'
        ? 'Project doc'
        : 'Document';

  return (
    <div className={`pending-question-document${panel ? ' pending-question-document-panel' : ''}`}>
      <div className="pending-question-context-row">
        <span className="muted">{kindLabel}</span>
        <span className="pending-question-context-title">{documentPath.split('/').pop()}</span>
        <button
          type="button"
          className="pending-question-context-link"
          onClick={() => navigateToTab({ kind: 'document', path: fullPath })}
        >
          Open {kindLabel.toLowerCase()}
        </button>
      </div>
      {error && <p className="muted small">Couldn't load preview: {error}</p>}
      {panel && content === null && !error && <p className="muted small">Loading document…</p>}
      {content !== null && (
        <>
          <div className="pending-question-document-preview">
            <RenderedMarkdown markdown={previewLines} />
          </div>
          {!panel && content.split('\n').length > 10 && (
            <button
              type="button"
              className="pending-question-document-expand subtle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Collapse' : 'Show full document'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function oneLine(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
