import type { Question, Task } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import { useSocialMode } from './useSocialMode.js';

/** A finished task counts as news for this long. */
const READY_WITHIN_MS = 3 * 24 * 60 * 60 * 1000;
const DISMISSED_KEY = 'gezel:visit-card-dismissed';

type VisitItem =
  | { kind: 'question'; key: string; text: string }
  | { kind: 'result'; key: string; text: string; taskRef: string };

const clip = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

function dismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function dismiss(key: string): void {
  try {
    const keys = [...dismissed(), key].slice(-200);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(keys));
  } catch {
    /* a private window keeps the card until the item is resolved */
  }
}

/**
 * The one thing a gezel has waiting for you, shown when you open its chat in
 * social mode: an open question it asked, else work it finished in the last
 * few days. Read from the questions and tasks already on disk — never a
 * model-written greeting, so an empty moment stays empty.
 */
export function pickVisitItem(
  gezelId: string,
  questions: readonly Question[],
  tasks: readonly Task[],
  now = Date.now(),
): VisitItem | null {
  const skip = dismissed();
  const question = questions
    .filter((q) => q.gezelId === gezelId && !q.answer && !skip.has(`question:${q.id}`))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (question)
    return { kind: 'question', key: `question:${question.id}`, text: clip(question.prompt) };
  const finished = tasks
    .filter(
      (t) =>
        t.status === 'complete' &&
        t.assignee.kind === 'gezel' &&
        t.assignee.gezelId === gezelId &&
        !t.parentTaskRef &&
        !t.nightShift &&
        now - Date.parse(t.updatedAt) < READY_WITHIN_MS &&
        !skip.has(`result:${t.ref}`),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return finished
    ? {
        kind: 'result',
        key: `result:${finished.ref}`,
        text: clip(finished.title),
        taskRef: finished.ref,
      }
    : null;
}

export function VisitCard({
  gezelId,
  gezelName,
  projectId,
  onOpenTask,
}: {
  gezelId: string;
  gezelName: string;
  projectId: string;
  onOpenTask?: (ref: string) => void;
}) {
  const social = useSocialMode();
  const [item, setItem] = useState<VisitItem | null>(null);
  useEffect(() => {
    if (!social) {
      setItem(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      runtimeCapabilities().structuredQuestions
        ? api.listQuestions({ projectId, pending: true }).then((r) => r.questions)
        : Promise.resolve([] as Question[]),
      runtimeCapabilities().tasks
        ? api.listProjectTasks(projectId, { status: 'complete' }).then((r) => r.tasks)
        : Promise.resolve([] as Task[]),
    ])
      .then(([questions, tasks]) => {
        if (!cancelled) setItem(pickVisitItem(gezelId, questions, tasks));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [social, gezelId, projectId]);
  if (!item) return null;
  return (
    <aside className="visit-card" aria-label={`Waiting from ${gezelName}`}>
      <span className="visit-card-text">
        {item.kind === 'question'
          ? `${gezelName} is waiting on your answer: ${item.text}`
          : `${gezelName} finished “${item.text}”.`}
      </span>
      {item.kind === 'result' && onOpenTask && (
        <button type="button" className="gz-key" onClick={() => onOpenTask(item.taskRef)}>
          Open
        </button>
      )}
      <button
        type="button"
        className="visit-card-dismiss"
        aria-label="Dismiss"
        onClick={() => {
          dismiss(item.key);
          setItem(null);
        }}
      >
        ×
      </button>
    </aside>
  );
}
