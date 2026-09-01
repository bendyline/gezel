import type { GezelSummary, TimelineMessage } from '@bendyline/gezel';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderDivider } from './chat-timeline-dividers.js';

vi.mock('./GezelIcon.js', () => ({
  GezelIcon: () => <span />,
}));

describe('timeline session divider lineage', () => {
  it('attributes a task handoff to the immediate step rather than the visual root', () => {
    const at = '2026-09-01T12:00:00.000Z';
    const message = {
      sessionId: 'write',
      gezelId: 'writer',
      projectId: 'default',
      sessionTitle: 'Write the deck',
      sessionCreatedAt: at,
      sessionLastActivityAt: at,
      sessionProviderName: 'copilot',
      taskRef: 'default/10',
      parentSession: { sessionId: 'root', gezelId: 'meester', kind: 'task-handoff' },
      handoffFrom: { sessionId: 'outline', gezelId: 'planner' },
      role: 'user',
      content: 'Write the deck.',
      at,
    } satisfies TimelineMessage;
    const gezels = new Map<string, GezelSummary>([
      ['meester', { id: 'meester', name: 'Meester' } as GezelSummary],
      ['planner', { id: 'planner', name: 'Planner' } as GezelSummary],
      ['writer', { id: 'writer', name: 'Writer' } as GezelSummary],
    ]);

    const { container } = render(
      renderDivider({
        row: { kind: 'message', msg: message, at },
        gezels,
        projects: new Map(),
        activeSessionId: undefined,
        continuing: false,
        key: 'write-divider',
        roleBasedNameOnlyMode: false,
      }),
    );

    expect(container.textContent).toContain('task hand-off to Writer');
    expect(container.textContent).toContain('from Planner');
    expect(container.textContent).not.toContain('from Meester');
  });
});
