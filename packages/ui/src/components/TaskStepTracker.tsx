import type { GezelSummary, TaskAssignee, TaskCraftbookStep, TaskStatus } from '@bendyline/gezel';
import { Poppetje } from '../poppetje/index.js';
import { type StepMeta, type StepStatus, StepTracker } from './StepTracker.js';
import { useShowPoppetjes } from './useShowPoppetjes.js';

interface TaskStepTrackerProps {
  steps: TaskCraftbookStep[];
  /** The step the task itself considers "active" (live work cursor). */
  activeStepId?: string;
  /** Which step the user has clicked on for viewing — independent of active. */
  selectedStepId: string | null;
  onSelect: (stepId: string) => void;
  onAddStep: () => void;
  /** Disables all interaction (e.g., while a mutation is in flight). */
  busy?: boolean;
  /** Roster used to resolve a step assignee to a name/role/figure. */
  gezels?: GezelSummary[];
  /** Task-level default assignee, inherited by steps that set none. */
  taskAssignee?: TaskAssignee;
  /** Whole-task status. Terminal states (complete/canceled) end the rail. */
  taskStatus?: TaskStatus;
  /**
   * Reassign a step inline from its caption. `null` clears the step's own
   * assignee (back to inheriting the task default). Omit → captions are
   * read-only text.
   */
  onAssign?: (stepId: string, assignee: TaskAssignee | null) => void;
}

/**
 * Once the task itself is complete or canceled, no step is active — the
 * task's end state lives on the terminal dot, not on a gezel.
 */
export function taskStepStatus(
  step: TaskCraftbookStep,
  activeStepId: string | undefined,
  terminal: boolean,
): StepStatus {
  if (step.completedAt) return 'done';
  if (!terminal && step.id === activeStepId) return 'active';
  return 'pending';
}

const STATUS_WORD: Record<StepStatus, string> = {
  done: 'Signed off',
  active: 'Active',
  pending: 'Waiting its turn',
};

/**
 * Task-step tracker — the workshop "bench rail" view of the shared
 * {@link StepTracker}. Supplies lifecycle status (done/active/pending) plus
 * per-step decoration: who's holding each step (its assignee, inherited
 * from the task when the step sets none), a status word, and — for the
 * active step — the assignee's carved poppetje standing on the rail.
 *
 * The craftbook editor uses the same bench in design mode (plain pegs, no
 * lifecycle status, with drag-reorder). Activating/completing a task step is
 * the per-step panel's responsibility.
 */
export function TaskStepTracker({
  steps,
  activeStepId,
  selectedStepId,
  onSelect,
  onAddStep,
  busy = false,
  gezels = [],
  taskAssignee,
  taskStatus,
  onAssign,
}: TaskStepTrackerProps) {
  const showFigures = useShowPoppetjes();
  const terminal = taskStatus === 'complete' || taskStatus === 'canceled';

  // Who applies when a step sets no assignee of its own: the gezel its
  // `suggestedRole` resolved into, then the task default. That order matches
  // the handoff paths — `onStepActivated` reads the step's own binding and
  // never the task assignee — so the tracker can't show one name while a
  // different gezel actually holds the step. Used for display and the
  // "inherit" label both.
  const inheritedNameFor = (step: TaskCraftbookStep): string | undefined => {
    const inh: TaskAssignee | null =
      (step.suggestedGezelId ? { kind: 'gezel', gezelId: step.suggestedGezelId } : null) ??
      taskAssignee ??
      null;
    if (inh?.kind === 'user') return 'you';
    if (inh?.kind === 'gezel') return gezels.find((g) => g.id === inh.gezelId)?.name;
    return undefined;
  };

  const stepOf = (step: TaskCraftbookStep): StepMeta => {
    const status = taskStepStatus(step, activeStepId, terminal);
    const assignee: TaskAssignee | null =
      step.assignee ??
      (step.suggestedGezelId ? { kind: 'gezel', gezelId: step.suggestedGezelId } : null) ??
      taskAssignee ??
      null;

    let name: string | undefined;
    let role: string | undefined;
    let gezel: GezelSummary | undefined;
    if (assignee?.kind === 'user') {
      name = 'You';
    } else if (assignee?.kind === 'gezel') {
      gezel = gezels.find((g) => g.id === assignee.gezelId);
      name = gezel?.name;
      role = gezel?.role;
    }

    // The active step reads as "<role> · with the task"; others just show role.
    const assigneeRole =
      status === 'active' ? (role ? `${role} · with the task` : 'with the task') : role;

    const figure =
      status === 'active' && showFigures && gezel?.poppetje ? (
        <Poppetje
          poppetje={gezel.poppetje}
          variant="full"
          size={26}
          svgId={`track-${step.id}`}
          {...(name ? { title: name } : {})}
        />
      ) : undefined;

    // In a terminal task nothing is "waiting its turn" — the task's end
    // state lives on the terminal dot. Keep "Signed off" for done steps.
    const statusWord = terminal && status === 'pending' ? undefined : STATUS_WORD[status];

    // Inline assignee picker. Its value is the step's OWN setting (a concrete
    // gezel / "you" / inherit) — distinct from the resolved `name` above,
    // which may come from the inherited default.
    const explicit = step.assignee;
    const value =
      explicit?.kind === 'user'
        ? '__user'
        : explicit?.kind === 'gezel'
          ? explicit.gezelId
          : '__inherit';
    const inheritedName = inheritedNameFor(step);
    const assigneeControl = onAssign ? (
      <select
        className="bench-step-select"
        value={value}
        disabled={busy}
        aria-label={`Assignee for ${step.name}`}
        title={`Assignee for ${step.name}`}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__inherit') onAssign(step.id, null);
          else if (v === '__user') onAssign(step.id, { kind: 'user' });
          else onAssign(step.id, { kind: 'gezel', gezelId: v });
        }}
      >
        <option value="__inherit">
          {inheritedName ? `inherit · ${inheritedName}` : 'inherit from task'}
        </option>
        <option value="__user">you</option>
        {gezels.map((g) => (
          <option key={g.id} value={g.id}>
            {g.role ? `${g.name} · ${g.role}` : g.name}
          </option>
        ))}
      </select>
    ) : undefined;

    return {
      ...(figure ? { figure } : {}),
      ...(assigneeControl ? { assigneeControl } : {}),
      ...(name ? { assigneeName: name } : {}),
      ...(assigneeRole ? { assigneeRole } : {}),
      ...(statusWord ? { statusWord } : {}),
    };
  };

  return (
    <StepTracker
      variant="bench"
      steps={steps}
      selectedStepId={selectedStepId}
      onSelect={onSelect}
      statusOf={(s) => taskStepStatus(s, activeStepId, terminal)}
      stepOf={stepOf}
      onAddStep={onAddStep}
      busy={busy}
      ariaLabel="Task steps"
      addLabel="add a step"
      {...(terminal
        ? {
            terminal: {
              word: taskStatus === 'complete' ? 'Complete' : 'Canceled',
              tone: taskStatus === 'complete' ? 'complete' : 'canceled',
            },
          }
        : {})}
    />
  );
}
