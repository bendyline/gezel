import type { GezelSummary, Task } from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { ChatComposer } from './ChatComposer.js';
import { ProjectTimeline } from './ProjectTimeline.js';
import { SessionSwitcher } from './SessionSwitcher.js';

/**
 * Inline chat surface for TaskDetail's Chat tab. One-on-one with the task's
 * assignee, scoped to this task via `taskRef` (+ the task's active step
 * when set). Sessions created here carry the scope automatically; existing
 * task-scoped sessions — including ones spun up by `advance_task_step`
 * handoffs — show up in the switcher.
 *
 * The project timeline below is still project-wide (interleaved with any
 * other sessions in the project) — the scoping bite is on the session
 * switcher and the composer, not the visible history.
 */
export function TaskChatPane({ task, gezels }: { task: Task; gezels: GezelSummary[] }) {
  const assigneeGezelId = task.assignee.kind === 'gezel' ? task.assignee.gezelId : undefined;
  const targetGezel = useMemo(() => {
    if (assigneeGezelId) {
      const found = gezels.find((g) => g.id === assigneeGezelId);
      if (found) return found;
    }
    return undefined;
  }, [assigneeGezelId, gezels]);

  const [sessionId, setSessionId] = useState<string>('');
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);

  // Reset session selection when the task changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: task.ref is the reset trigger.
  useEffect(() => {
    setSessionId('');
  }, [task.ref]);

  if (task.assignee.kind === 'user') {
    return (
      <div className="task-detail-chat-empty muted">
        This task is assigned to you. Assign it to a gezel to chat about it here.
      </div>
    );
  }

  if (!targetGezel) {
    return (
      <div className="task-detail-chat-empty muted">
        The assigned gezel (<code>{assigneeGezelId}</code>) isn&apos;t available on this install.
        Reassign the task to chat about it here.
      </div>
    );
  }

  return (
    <div className="task-detail-chat">
      <ProjectTimeline
        projectId={task.projectId}
        activeSessionId={sessionId || undefined}
        onFocusSession={(sid, gid) => {
          if (gid === targetGezel.id) setSessionId(sid);
        }}
      />
      <ChatComposer
        gezelId={targetGezel.id}
        gezelName={targetGezel.name}
        gezelIcon={targetGezel.icon ?? null}
        gezelPoppetje={targetGezel.poppetje}
        gezelIconOverride={targetGezel.iconOverride}
        projectId={task.projectId}
        sessionId={sessionId || undefined}
        onSessionCreated={(sid) => {
          setSessionId(sid);
          setSessionRefreshKey((k) => k + 1);
        }}
        taskRef={task.ref}
        {...(task.activeStepId ? { stepId: task.activeStepId } : {})}
        placeholder={`Talk to ${targetGezel.name} about ${task.ref}.`}
        belowAddressLine={
          <SessionSwitcher
            gezelId={targetGezel.id}
            projectId={task.projectId}
            sessionId={sessionId || undefined}
            onSessionIdChange={(next) => setSessionId(next ?? '')}
            refreshKey={sessionRefreshKey}
            taskRef={task.ref}
            {...(task.activeStepId ? { stepId: task.activeStepId } : {})}
          />
        }
      />
    </div>
  );
}
