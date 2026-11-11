import { describe, expect, it } from 'vitest';
import type { RequestTrack } from '../schemas/request-track.js';
import type { Task } from '../schemas/task.js';
import { T, invoices, priceList } from './fixtures/bakery.js';
import { withRequestTitles } from './title.js';

function track(taskRef: string | undefined, over: Partial<RequestTrack> = {}): RequestTrack {
  return {
    key: `mees-thread@${T(20)}`,
    sessionId: 'mees-thread',
    projectId: 'default',
    at: T(20),
    summary: 'And a price list as a PDF, please.',
    kind: taskRef ? 'work' : 'conversation',
    stop: 'ready',
    state: 'ready',
    ...(taskRef ? { actual: { taskRef } } : {}),
    taskRefs: taskRef ? [taskRef] : [],
    liveSessionIds: [],
    crew: [],
    questionIds: [],
    ...over,
  };
}

describe('withRequestTitles', () => {
  it("names a request by its task's title, in the person's words", () => {
    const asked: Task = { ...priceList, title: 'Price list as a PDF' };
    const [named] = withRequestTitles([track(asked.ref)], [invoices, asked]);
    expect(named?.title).toBe('Price list as a PDF');
  });

  it("leaves out a title that is only the plan's name", () => {
    // The bakery's price list was the task "Formatted Report".
    const [unnamed] = withRequestTitles([track(priceList.ref)], [priceList]);
    expect(unnamed).not.toHaveProperty('title');
  });

  it('passes through a reply with no work, and work whose task is not at hand', () => {
    const reply = track(undefined);
    const orphan = track('bakery/99');
    expect(withRequestTitles([reply, orphan], [priceList])).toEqual([reply, orphan]);
  });
});
