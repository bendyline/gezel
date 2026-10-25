import type { ActivityTurn } from '../../activity.js';
import type { Task, TaskCraftbookStep } from '../../schemas/task.js';
import type { RequestThread } from '../resolve.js';

/**
 * The bakery's first hour (UX review, 2026-10-23), as the records it left.
 * The owner asked the Meester for October's invoices (m1), then for a price
 * list (m2). Dejan leads the bakery project; Aditya drafts. The price list
 * finished and the Meester is still writing its closing reply; the invoices
 * are being drafted, with one shard of a fanout out.
 */
export const T = (minutes: number) =>
  new Date(Date.parse('2026-10-23T09:00:00Z') + minutes * 60_000).toISOString();
export const NOW = Date.parse(T(30));

export const meesterThread: RequestThread = {
  id: 'mees-thread',
  gezelId: 'mees',
  projectId: 'default',
  messages: [
    {
      id: 'm1',
      role: 'user',
      at: T(0),
      content: 'Make my October invoices for the three cafe clients',
    },
    { role: 'assistant', at: T(2), content: 'Dejan is on it.' },
    { id: 'm2', role: 'user', at: T(20), content: 'And a price list as a PDF, please.' },
    {
      role: 'assistant',
      at: T(28),
      content: 'Your PDF for **Price list** is ready.',
      synthetic: 'task-wrapup',
      referencedTasks: ['bakery/2'],
      deliverable: { kind: 'artifact', path: 'tasks/2/report.pdf', projectId: 'bakery' },
      makerGezelId: 'aditya',
    },
  ],
};

function step(id: string, over: Partial<TaskCraftbookStep> = {}): TaskCraftbookStep {
  return { id, name: id, createdAt: T(0), ...over } as TaskCraftbookStep;
}

export const invoices: Task = {
  projectId: 'bakery',
  num: 1,
  ref: 'bakery/1',
  title: 'Invoice run',
  status: 'active',
  assignee: { kind: 'gezel', gezelId: 'dejan' },
  activeStepId: 'draft',
  requestRef: { sessionId: 'mees-thread', at: T(0), messageId: 'm1' },
  launchSessionId: 'mees-thread',
  sourceCraftbookIds: [{ role: 'main', catalogId: 'invoice-run' }],
  craftbook: {
    id: 'invoice-run',
    name: 'Invoice run',
    entryStepId: 'scope',
    steps: [
      step('scope', { name: 'Scope the month', next: 'draft', completedAt: T(4) }),
      step('draft', {
        name: 'Draft the invoices',
        next: 'evaluate',
        lastActivatedAt: T(26),
        assignee: { kind: 'gezel', gezelId: 'aditya' },
        advanceWhen: { file: 'invoices/october.pdf' },
      }),
      step('evaluate', { name: 'Evaluate', next: 'finish' }),
      step('finish', { name: 'Finish', terminal: true }),
    ],
  },
  createdAt: T(1),
  updatedAt: T(26),
  createdBy: { kind: 'gezel', gezelId: 'mees' },
} as unknown as Task;

/** One shard of the invoice fanout, waiting for the model. */
export const invoiceShard: Task = {
  ...invoices,
  num: 4,
  ref: 'bakery/4',
  title: 'Invoice for Cafe Noord',
  parentTaskRef: 'bakery/1',
  activeStepId: 'draft',
  createdAt: T(26),
} as Task;

export const priceList: Task = {
  projectId: 'bakery',
  num: 2,
  ref: 'bakery/2',
  title: 'Formatted Report',
  status: 'complete',
  assignee: { kind: 'gezel', gezelId: 'dejan' },
  requestRef: { sessionId: 'mees-thread', at: T(20), messageId: 'm2' },
  launchSessionId: 'mees-thread',
  sourceCraftbookIds: [{ role: 'main', catalogId: 'report-pdf' }],
  craftbook: {
    id: 'report-pdf',
    name: 'Formatted Report',
    entryStepId: 'write',
    steps: [
      step('write', { name: 'Write the report', next: 'evaluate', completedAt: T(24) }),
      step('evaluate', { name: 'Evaluate', next: 'finish', completedAt: T(26) }),
      step('finish', { name: 'Finish', terminal: true, completedAt: T(27) }),
    ],
  },
  createdAt: T(21),
  updatedAt: T(27),
  createdBy: { kind: 'gezel', gezelId: 'mees' },
} as unknown as Task;

export const draftTurn: ActivityTurn = {
  sessionId: 'step-draft',
  gezelId: 'aditya',
  projectId: 'bakery',
  taskRef: 'bakery/1',
  userText: 'The previous step has been completed and handed step `draft`',
  startedAt: Date.parse(T(26)),
};

/** The Meester writing its closing reply after the price list's wrap-up. */
export const closingTurn: ActivityTurn = {
  sessionId: 'mees-thread',
  gezelId: 'mees',
  projectId: 'default',
  userText: 'And a price list as a PDF, please.',
  startedAt: Date.parse(T(28)),
};
