import type { GezelSummary, Project, Task } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
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
  if (!task) return <p className="placeholder">Loading task…</p>;

  return <TaskDetail task={task} gezels={gezels} projectName={projectName} onChanged={onChanged} />;
}
