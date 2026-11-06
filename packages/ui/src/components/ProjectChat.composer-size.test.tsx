import type { ChatEventEnvelope, GezelSummary, ProjectDetail } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import * as primitivesMock from '../test-utils/primitivesMock.js';

/**
 * The compose frame's size belongs to the frame, not to whichever composer is
 * mounted in it: a draft taken to full height stays there when the person
 * flips to the terminal, and the terminal hands it back the same way.
 */

const stream = vi.hoisted(() => ({
  async *consume(): AsyncGenerator<ChatEventEnvelope> {
    await new Promise<void>(() => {});
  },
}));

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: () => stream.consume(),
}));
vi.mock('./useShowAdvancedFeatures.js', () => ({ useShowAdvancedFeatures: () => true }));
vi.mock('./GezelIcon.js', () => ({ GezelIcon: () => <span /> }));
vi.mock('../views/tasks/NewTaskDialog.js', () => ({ NewTaskDialog: () => null }));
vi.mock('./ProjectTimeline.js', () => ({ ProjectTimeline: () => <div data-testid="timeline" /> }));
vi.mock('./SessionSwitcher.js', () => ({ SessionSwitcher: () => null }));
vi.mock('./FolderTreeSwitcher.js', () => ({ FolderTreeSwitcher: () => null }));
vi.mock('./ChatReferences.js', () => ({
  ChatReferences: ({ children }: { children: (api: Record<string, unknown>) => ReactNode }) => (
    <div>
      {children({
        onToolActivity: vi.fn(),
        onArtifactReference: vi.fn(),
        onWorkspaceReference: vi.fn(),
        onTaskReference: vi.fn(),
      })}
    </div>
  ),
}));

interface SizedComposerProps {
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

function sizedComposer(testId: string, trailing: ReactNode, props: SizedComposerProps) {
  return (
    <div data-testid={testId} data-expanded={props.expanded ? 'true' : 'false'}>
      <button type="button" onClick={() => props.onExpandedChange?.(!props.expanded)}>
        Toggle size
      </button>
      {trailing}
    </div>
  );
}

vi.mock('./ChatComposer.js', () => ({
  ChatComposer: (props: SizedComposerProps & { addressLineTrailing?: ReactNode }) =>
    sizedComposer('chat-composer', props.addressLineTrailing, props),
}));
vi.mock('./TerminalComposer.js', () => ({
  TerminalComposer: (props: SizedComposerProps & { toolbarTrailing?: ReactNode }) =>
    sizedComposer('terminal-composer', props.toolbarTrailing, props),
  queueTerminalCommand: vi.fn(),
}));

const { ProjectChat } = await import('./ProjectChat.js');
const { api } = await import('../api.js');

const PROJECT = {
  id: 'p1',
  name: 'site',
  projectTypeId: 'web-app',
  voormanGezelId: 'g1',
  gezelIds: ['g1'],
} as unknown as ProjectDetail;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listGezels).mockResolvedValue({
    gezels: [{ id: 'g1', name: 'Amadou' }] as unknown as GezelSummary[],
  });
  vi.mocked(api.listInflightTurns).mockResolvedValue({ inflight: [] });
  vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [] });
  vi.mocked(api.listTaskSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [] });
});

describe('ProjectChat compose frame size', () => {
  it('keeps the frame expanded across a flip to the terminal and back', async () => {
    const user = userEvent.setup();
    render(<ProjectChat project={PROJECT} />);

    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Toggle size' }));
    expect(screen.getByTestId('chat-composer')).toHaveAttribute('data-expanded', 'true');

    await user.click(screen.getByRole('tab', { name: /Terminal/ }));
    expect(screen.getByTestId('terminal-composer')).toHaveAttribute('data-expanded', 'true');

    // Given back from the terminal, it stays given back in chat.
    await user.click(screen.getByRole('button', { name: 'Toggle size' }));
    expect(screen.getByTestId('terminal-composer')).toHaveAttribute('data-expanded', 'false');

    await user.click(screen.getByRole('tab', { name: 'AI chat' }));
    expect(screen.getByTestId('chat-composer')).toHaveAttribute('data-expanded', 'false');
  });
});
