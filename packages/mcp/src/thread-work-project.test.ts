import { describe, expect, it } from 'vitest';
import { threadWorkProject } from './thread-work-project.js';

const THREAD = 'meester-thread';
const at = '2026-11-09T20:37:46.000Z';

const projects = [
  { id: 'default' },
  { id: 'bakery-office', status: 'active' },
  { id: 'checklist', status: 'stable' },
  { id: 'old', status: 'active', archived: true },
  { id: 'shared', properties: { 'gezel.sharedLibrary': '1' } },
];

describe('threadWorkProject', () => {
  // default/2, 2026-11-09: the proposal asked for in the thread that set up
  // the bakery's office ran in Default and never named the bakery.
  it('carries a Default thread on in the one project it set up', () => {
    expect(
      threadWorkProject({
        sessionId: THREAD,
        projects,
        tasks: [
          { projectId: 'bakery-office', requestRef: { sessionId: THREAD, at } },
          { projectId: 'default', requestRef: { sessionId: THREAD, at } },
        ],
      }),
    ).toBe('bakery-office');
  });

  it('counts a task the thread launched before requests were stamped', () => {
    expect(
      threadWorkProject({
        sessionId: THREAD,
        projects,
        tasks: [{ projectId: 'checklist', launchSessionId: THREAD }],
      }),
    ).toBe('checklist');
  });

  it('leaves the choice to the person when the thread set up several projects', () => {
    expect(
      threadWorkProject({
        sessionId: THREAD,
        projects,
        tasks: [
          { projectId: 'bakery-office', requestRef: { sessionId: THREAD, at } },
          { projectId: 'checklist', launchSessionId: THREAD },
        ],
      }),
    ).toBeUndefined();
  });

  it("ignores other threads' work, Default, and projects set aside", () => {
    expect(
      threadWorkProject({
        sessionId: THREAD,
        projects: [...projects, { id: 'paused', status: 'readonly' }],
        tasks: [
          { projectId: 'bakery-office', requestRef: { sessionId: 'another-thread', at } },
          { projectId: 'default', launchSessionId: THREAD },
          { projectId: 'old', launchSessionId: THREAD },
          { projectId: 'paused', launchSessionId: THREAD },
          { projectId: 'gone', launchSessionId: THREAD },
        ],
      }),
    ).toBeUndefined();
  });
});
