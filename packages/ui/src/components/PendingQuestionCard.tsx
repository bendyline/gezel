import type {
  NpmInstallApprovalDecision,
  NpmInstallApprovalPackage,
  Question,
  Task,
} from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { RenderedMarkdown } from './chat-bubbles.js';

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
 * Interactive card for a structured question. Rendered:
 *   - inline below the assistant bubble that asked it (chat-bubbles.tsx)
 *   - in the Home "Needs your input" panel (HomeView)
 *
 * Same component, same answer flow either way. When the underlying
 * `question` arrives with `answer` set, the card auto-collapses to the
 * read-only "Answered" form.
 */
export function PendingQuestionCard({
  question,
  onAnswered,
  onOpenInChat,
}: {
  question: Question;
  /** Called after a successful submit/skip — parent can refresh lists. */
  onAnswered?: (q: Question) => void;
  /**
   * Optional "Open in chat" link target. The chat-bubble surface
   * doesn't pass this (we're already in chat); the Home pane does.
   */
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
  return <PendingForm question={question} onAnswered={onAnswered} onOpenInChat={onOpenInChat} />;
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
        {onOpenInChat && (
          <button
            type="button"
            className="pending-question-open subtle"
            onClick={() => onOpenInChat(question)}
          >
            Open in chat
          </button>
        )}
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
        {onOpenInChat && (
          <button
            type="button"
            className="pending-question-open subtle"
            onClick={() => onOpenInChat(question)}
          >
            Open in chat
          </button>
        )}
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
        Claude wants to use the <code>{intent.toolName}</code> tool.
      </div>
      {Object.keys(intent.toolInput).length > 0 && (
        <details className="pending-question-tool-args" open>
          <summary>Arguments</summary>
          <pre>
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
        {onOpenInChat && (
          <button
            type="button"
            className="pending-question-open subtle"
            onClick={() => onOpenInChat(question)}
          >
            Open in chat
          </button>
        )}
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

function PendingForm({
  question,
  onAnswered,
  onOpenInChat,
}: {
  question: Question;
  onAnswered?: (q: Question) => void;
  onOpenInChat?: (question: Question) => void;
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
                className={`pending-question-choice${selected.has(i) ? ' is-selected' : ''}`}
                onClick={() => toggleChoice(i)}
                aria-pressed={selected.has(i)}
              >
                {choice}
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
              title="Dismiss the question. The gezel keeps doing nothing — its turn already ended."
            >
              Skip
            </button>
            <button
              type="button"
              className="pending-question-skip subtle"
              onClick={() => void submit('just-do-whatever')}
              disabled={submitting}
              title="Tell the gezel to proceed without your input, using sensible defaults."
            >
              Just do whatever
            </button>
          </>
        )}
        {onOpenInChat && (
          <button
            type="button"
            className="pending-question-open subtle"
            onClick={() => onOpenInChat(question)}
            disabled={autoSubmittingIdx !== null}
          >
            Open in chat
          </button>
        )}
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
        {onOpenInChat && (
          <button
            type="button"
            className="pending-question-open subtle"
            onClick={() => onOpenInChat(question)}
          >
            Open in chat
          </button>
        )}
      </div>
    </div>
  );
}

// ── Context strip (task / document attachments) ─────────────────────

function ContextStrip({ question }: { question: Question }) {
  if (!question.taskRef && !question.documentPath) return null;
  return (
    <div className="pending-question-context">
      {question.taskRef && <TaskContext taskRef={question.taskRef} />}
      {question.documentPath && (
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
      <a className="pending-question-context-link" href={`#tasks/${taskRef}`}>
        Open task
      </a>
    </div>
  );
}

function DocumentContext({
  projectId,
  documentPath,
}: {
  projectId: string;
  documentPath: string;
}) {
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
    const lines = content.split('\n');
    return expanded ? content : lines.slice(0, 10).join('\n');
  }, [content, expanded]);

  const kindLabel =
    resolvedKind === 'artifact'
      ? 'Artifact'
      : resolvedKind === 'project-document'
        ? 'Project doc'
        : 'Document';

  return (
    <div className="pending-question-document">
      <div className="pending-question-context-row">
        <span className="muted">{kindLabel}</span>
        <span className="pending-question-context-title">{documentPath.split('/').pop()}</span>
        <a
          className="pending-question-context-link"
          href={`#documents/${encodeURIComponent(fullPath)}`}
        >
          Open {kindLabel.toLowerCase()}
        </a>
      </div>
      {error && <p className="muted small">Couldn't load preview: {error}</p>}
      {content !== null && (
        <>
          <div className="pending-question-document-preview">
            <RenderedMarkdown markdown={previewLines} />
          </div>
          {content.split('\n').length > 10 && (
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
