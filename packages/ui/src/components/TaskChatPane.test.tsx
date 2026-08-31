import type { GezelSummary, Task } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskChatPane } from './TaskChatPane.js';

vi.mock('./ChatComposer.js', () => ({
  ChatComposer: ({ placeholder }: { placeholder?: string }) => <div>{placeholder}</div>,
}));
vi.mock('./ProjectTimeline.js', () => ({
  ProjectTimeline: () => <div data-testid="timeline" />,
}));
vi.mock('./SessionSwitcher.js', () => ({
  SessionSwitcher: () => <div data-testid="session-switcher" />,
}));
vi.mock('./useRoleBasedNameOnlyMode.js', () => ({
  useRoleBasedNameOnlyMode: () => true,
}));

const TASK = {
  ref: 'gezel/49',
  projectId: 'gezel',
  assignee: { kind: 'gezel', gezelId: 'toan' },
} as unknown as Task;

const TOAN = {
  id: 'toan',
  name: 'Toan',
  roleBasedName: 'developer',
  role: 'Developer',
} as GezelSummary;

describe('TaskChatPane', () => {
  it('uses the role-based name in the composer prompt in boring mode', () => {
    render(<TaskChatPane task={TASK} gezels={[TOAN]} />);

    expect(screen.getByText('Talk to developer about gezel/49.')).toBeInTheDocument();
    expect(screen.queryByText(/Talk to Toan/)).not.toBeInTheDocument();
  });
});
