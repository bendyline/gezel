import type { GezelSummary, Project, Task } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useTaskEvents } from '../components/useTaskResult.js';
import { TaskDetail } from './TaskDetail.js';

interface TaskTabContentProps {
  taskRef: string;
  /** Bubbles every task mutation up so an enclosing list can stay in sync
   *  without waiting for its next poll. */
  onTaskChanged?: (t: Task) => void;
}

export function TaskTabContent({ taskRef, onTaskChanged }: TaskTabContentProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [projectName, setProjectName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTask(null);
    setError(null);
    void (async () => {
      try {
        const [t, gz, pj] = await Promise.all([
          api.getTaskByRef(taskRef),
          api.listGezels(),
          api.listProjects(),
        ]);
        if (cancelled) return;
        setTask(t);
        setGezels(gz.gezels);
        const project = pj.projects.find((p: Project) => p.id === t.projectId);
        setProjectName(project?.name ?? '');
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskRef]);

  // The bench is a live view: a step advancing, a gezel hired for the next
  // step, or the task settling re-reads it. It froze at whatever the task
  // looked like when the tab opened, so a run that moved on still showed its
  // first step as current.
  useTaskEvents(task?.projectId, task?.ref, () => {
    void Promise.all([api.getTaskByRef(taskRef), api.listGezels()])
      .then(([t, gz]) => {
        setTask(t);
        setGezels(gz.gezels);
      })
      .catch(() => {});
  });

  const onChanged = useCallback(
    (updated: Task) => {
      setTask(updated);
      onTaskChanged?.(updated);
    },
    [onTaskChanged],
  );

  if (error) {
    return (
      <div className="placeholder">
        <p>
          Couldn't load task <code>{taskRef}</code>: {error}
        </p>
      </div>
    );
  }
  if (!task) return null;

  return <TaskDetail task={task} gezels={gezels} projectName={projectName} onChanged={onChanged} />;
}
