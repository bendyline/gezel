import type { RequestTrack, TimelineMessage } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  isAbsorbedCrewIntro,
  isTrackedWrapUp,
  requestKeyOfRoot,
  trackedSessions,
  trackedTaskCards,
  trackedTaskRefs,
} from './request-track-placement.js';

const track = (over: Partial<RequestTrack>): RequestTrack =>
  ({
    key: 's@t',
    sessionId: 's',
    kind: 'work',
    state: 'working',
    taskRefs: ['p/1', 'p/2'],
    liveSessionIds: ['step'],
    ...over,
  }) as RequestTrack;

describe('request tracker placement', () => {
  it("roots a tracker on the person's own message only", () => {
    const root = { role: 'user', sessionId: 's', at: 't' } as TimelineMessage;
    expect(requestKeyOfRoot(root)).toBe('s@t');
    expect(requestKeyOfRoot({ ...root, origin: 'system' })).toBeUndefined();
    expect(requestKeyOfRoot({ ...root, from: { gezelId: 'g', gezelName: 'G' } })).toBeUndefined();
    expect(requestKeyOfRoot({ ...root, taskRef: 'p/1' })).toBeUndefined();
    expect(requestKeyOfRoot({ ...root, role: 'assistant' })).toBeUndefined();
  });

  it('speaks for the work of tracked requests, not for a reply being written', () => {
    const tracks = [track({}), track({ key: 'c', kind: 'conversation', taskRefs: ['p/9'] })];
    expect([...trackedTaskRefs(tracks)]).toEqual(['p/1', 'p/2']);
    expect([...trackedSessions(tracks)].sort()).toEqual(['s', 'step']);
    expect([...trackedSessions([track({ state: 'ready', liveSessionIds: [] })])]).toEqual([]);
  });

  it('finds the cards, joined introductions and wrap-ups of tracked work', () => {
    const refs = new Set(['p/1']);
    const card = { kind: 'craftbook-start', taskRef: 'p/1' };
    const other = { kind: 'craftbook-start', taskRef: 'p/3' };
    const messages = [
      { toolCalls: [{ card }, { card: other }, { name: 'read_file' }] },
    ] as unknown as TimelineMessage[];
    expect([...trackedTaskCards(messages, refs)]).toEqual([card]);
    const joined = {
      synthetic: 'crew-introduction',
      crewIntroduction: { taskRef: 'p/1', moment: 'joined', members: [] },
    } as unknown as TimelineMessage;
    expect(isAbsorbedCrewIntro(joined, refs)).toBe(true);
    expect(
      isAbsorbedCrewIntro(
        { ...joined, crewIntroduction: { ...joined.crewIntroduction!, moment: 'kickoff' } },
        refs,
      ),
    ).toBe(false);
    expect(
      isTrackedWrapUp(
        { synthetic: 'task-wrapup', referencedTasks: ['p/1'] } as TimelineMessage,
        refs,
      ),
    ).toBe(true);
  });
});
