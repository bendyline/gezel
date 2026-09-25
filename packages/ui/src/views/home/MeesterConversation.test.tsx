// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../../components/GezelIcon.js', () => ({ GezelIcon: () => <span /> }));
vi.mock('../../components/GlobalTimeline.js', () => ({
  GlobalTimeline: () => <div data-testid="timeline" />,
}));
vi.mock('../../components/ChatReferences.js', () => ({
  ChatReferences: ({
    children,
  }: {
    children: (rail: Record<string, unknown>) => React.ReactNode;
  }) => <>{children({ recentReferences: [], onOpenReference: () => {} })}</>,
}));
vi.mock('../../components/ChatComposer.js', () => ({
  ChatComposer: ({
    sessionId,
    belowAddressLine,
    taskLaunch,
  }: {
    sessionId?: string;
    belowAddressLine?: React.ReactNode;
    taskLaunch?: unknown;
  }) => (
    <div
      data-testid="composer"
      data-session={sessionId ?? ''}
      data-task-launch={taskLaunch ? 'true' : 'false'}
    >
      {belowAddressLine}
    </div>
  ),
}));
vi.mock('../../components/SessionSwitcher.js', () => ({
  SessionSwitcher: ({ autoPickNewest }: { autoPickNewest?: boolean }) => (
    <div data-testid="switcher" data-auto-pick={String(autoPickNewest ?? true)} />
  ),
}));

const { MeesterConversation } = await import('./MeesterConversation.js');
const { writeChatThreadSelection, resetChatThreadMemory, MEESTER_THREAD_KEY } = await import(
  '../../components/chat-thread-memory.js'
);

const props = {
  meesterGezelId: 'meester-1',
  meesterName: 'Ulrike',
  meesterIcon: null,
  meesterPoppetje: null,
  meesterIconOverride: false,
};

describe('MeesterConversation', () => {
  beforeEach(() => {
    resetChatThreadMemory();
  });

  it('opens on a fresh thread at launch, with the attached task available', () => {
    render(<MeesterConversation {...props} />);
    // The front door has to show the Task key, which lives on a fresh
    // thread — so the picker must not auto-pick yesterday's conversation.
    expect(screen.getByTestId('switcher')).toHaveAttribute('data-auto-pick', 'false');
    expect(screen.getByTestId('composer')).toHaveAttribute('data-session', '');
    expect(screen.getByTestId('composer')).toHaveAttribute('data-task-launch', 'true');
  });

  it('still returns to the thread the person was just in', () => {
    writeChatThreadSelection(MEESTER_THREAD_KEY, {
      gezelId: 'meester-1',
      projectId: 'default',
      sessionId: 'session-9',
    });
    render(<MeesterConversation {...props} />);
    expect(screen.getByTestId('composer')).toHaveAttribute('data-session', 'session-9');
  });
});
