/**
 * Task dispatch seeds are written for the model, not for the reader.
 * `ChatManager.startHandoffSession` sends a paragraph that names the
 * previous gezel, the step, the task ref, and then four sentences of
 * tool-calling procedure — and it lands in the transcript as a
 * `role: 'user'` turn the person never typed (see `ChatMessage.origin`).
 * Rendered verbatim it reads as machinery talking: the sticky header
 * truncates it mid-word and the bubble buries the one fact a reader
 * wants ("Liesel passed this to Koray") under boilerplate.
 *
 * This module pulls the facts back out of the seed so the surfaces can
 * render a short hand-off line and keep the procedure in provenance.
 * Parsing prose is deliberate: the seed is not persisted in a structured
 * form, and back-filling one onto every existing session on disk would
 * not fix the transcripts already written. The wordings below are the
 * four `startHandoffSession` seeds verbatim — if you change a seed
 * there, change the matching pattern here (the test pins both).
 */

export type TaskHandoffKind = 'handoff' | 'entry' | 'advance' | 'resume';

export interface TaskHandoffNote {
  kind: TaskHandoffKind;
  /** `{projectId}/{num}` — chip-able reference to the owning task. */
  taskRef: string;
  /** Craftbook step id, as authored (`review`, `write-deck`). */
  stepId: string;
  /** Previous step's gezel. Absent on `entry`/`advance`/`resume`, and on
   *  a hand-off whose sender could not be resolved (deleted gezel, or
   *  role-based-name-only mode withholding the name). */
  fromName?: string;
  /** Task title, when the entry preface carried one. */
  taskTitle?: string;
  /** Craftbook the task was created from, when the entry preface named it. */
  craftbook?: string;
}

const HANDOFF_RE =
  /^(?:(.+?) has handed|The previous step has been completed and handed) step `([^`]+)` of task (\S+?) to you\./;
const ENTRY_RE = /You've been assigned task (\S+?) \(step `([^`]+)`\)\./;
const ENTRY_PREFACE_RE =
  /^Task (\S+?) \("([^"]*)"\) was just created from the \*\*(.+?)\*\* craftbook\./;
const ADVANCE_RE =
  /^Task (\S+?) has advanced to the next step — `([^`]+)`, which is yours as well\./;
const RESUME_RE = /^The service restarted while task (\S+?) was still active on step `([^`]+)`\./;

/**
 * Recognise a task dispatch seed. Returns `null` for every other
 * machine-authored turn (page reactions, voorman nudges, closing-summary
 * prompts) — those keep the plain System bubble.
 */
export function parseTaskHandoffNote(content: string): TaskHandoffNote | null {
  const text = content.trim();

  const handoff = HANDOFF_RE.exec(text);
  if (handoff) {
    const [, fromName, stepId, taskRef] = handoff;
    return {
      kind: 'handoff',
      taskRef: taskRef!,
      stepId: stepId!,
      ...(fromName?.trim() ? { fromName: fromName.trim() } : {}),
    };
  }

  const advance = ADVANCE_RE.exec(text);
  if (advance) return { kind: 'advance', taskRef: advance[1]!, stepId: advance[2]! };

  const resume = RESUME_RE.exec(text);
  if (resume) return { kind: 'resume', taskRef: resume[1]!, stepId: resume[2]! };

  // Entry seeds are prefixed with the craftbook + step-arc preface, so the
  // assignment sentence is matched anywhere in the text rather than anchored.
  const entry = ENTRY_RE.exec(text);
  if (entry) {
    const preface = ENTRY_PREFACE_RE.exec(text);
    return {
      kind: 'entry',
      taskRef: entry[1]!,
      stepId: entry[2]!,
      ...(preface?.[2]?.trim() ? { taskTitle: preface[2].trim() } : {}),
      ...(preface?.[3]?.trim() ? { craftbook: preface[3].trim() } : {}),
    };
  }

  return null;
}

/**
 * Boring mode ("role-based names only") resolves a sender to a lowercase
 * role — `reviewer has handed step …`. That word opens the card's sentence,
 * so it gets sentence case; a real name is already capitalised and unchanged.
 */
function sentenceCase(line: string): string {
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** `write-deck` → `write deck`. Step ids are slugs; the card reads as prose. */
export function humanizeStepId(stepId: string): string {
  return stepId.replace(/[-_]+/g, ' ').trim();
}

/**
 * One sentence naming who passed what to whom — the whole point of the
 * card. `receiver` is the session's own gezel; it is always known at the
 * call sites (bubble and sticky header both resolve it for their author
 * label), so there is no anonymous branch for it.
 */
export function handoffHeadline(note: TaskHandoffNote, receiver: string): string {
  const step = humanizeStepId(note.stepId);
  switch (note.kind) {
    case 'handoff':
      return note.fromName
        ? sentenceCase(`${note.fromName} passed the ${step} step to ${receiver}.`)
        : `The ${step} step was passed to ${receiver}.`;
    case 'entry':
      return sentenceCase(`${receiver} was assigned the ${step} step.`);
    case 'advance':
      return sentenceCase(`${receiver} continues with the ${step} step.`);
    case 'resume':
      return sentenceCase(`${receiver} picked the ${step} step back up after a restart.`);
  }
}

/**
 * Two words naming what happened, for the card's kind label and the sticky
 * header's author tag. Not "SYSTEM": the machinery is the *sender* here, and
 * a reader scanning a task thread wants to know which of the four it is.
 */
export function handoffKindLabel(note: TaskHandoffNote): string {
  switch (note.kind) {
    case 'handoff':
      return 'Hand-off';
    case 'entry':
      return 'New task';
    case 'advance':
      return 'Next step';
    case 'resume':
      return 'Resumed';
  }
}

/**
 * The same fact with nobody to address it to — a glanceable one-liner for
 * surfaces that summarise a thread rather than render it (the chat pill's
 * context line, a task card). No receiver: those surfaces already name the
 * gezel the thread belongs to.
 */
export function handoffSummary(note: TaskHandoffNote): string {
  const step = humanizeStepId(note.stepId);
  switch (note.kind) {
    case 'handoff':
      return note.fromName
        ? sentenceCase(`${note.fromName} passed on the ${step} step.`)
        : `The ${step} step was passed on.`;
    case 'entry':
      return note.craftbook
        ? `Assigned the ${step} step — ${note.craftbook}.`
        : `Assigned the ${step} step.`;
    case 'advance':
      return `Continuing with the ${step} step.`;
    case 'resume':
      return `Picked the ${step} step back up after a restart.`;
  }
}

/**
 * `handoffSummary` for a preview that may have been **cut short**. Session
 * summaries carry a bounded 200-character slice of the last message
 * (`Store.listSessions`), and an entry seed spends that budget on its
 * craftbook + step-arc preface — the assignment sentence the strict parse
 * anchors on is past the cut. Recognising the preface alone keeps a fresh
 * task's pill from reading as a wall of the arc.
 *
 * Returns `null` for anything that is not a dispatch seed.
 */
export function handoffPreviewLine(raw: string): string | null {
  const note = parseTaskHandoffNote(raw);
  if (note) return handoffSummary(note);
  const preface = ENTRY_PREFACE_RE.exec(raw.trim());
  if (!preface) return null;
  return newTaskLine(preface[2]?.trim(), preface[3]?.trim());
}

/** The one wording for "where this task came from", shared by both surfaces. */
function newTaskLine(title?: string, craftbook?: string): string {
  if (title && craftbook) return `New task “${title}” — ${craftbook}.`;
  if (craftbook) return `New task from the ${craftbook} craftbook.`;
  if (title) return `New task “${title}”.`;
  return 'New task.';
}

/** Second line of the card — context, never instructions. Empty when there is none. */
export function handoffContextLine(note: TaskHandoffNote): string {
  return note.kind === 'entry' ? newTaskLine(note.taskTitle, note.craftbook) : '';
}
