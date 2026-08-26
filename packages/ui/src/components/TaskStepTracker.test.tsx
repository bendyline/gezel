import { type GezelSummary, type TaskCraftbookStep, poppetjeFromSeed } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { TaskStepTracker } = await import('./TaskStepTracker.js');
const { api } = await import('../api.js');

const GEZELS: GezelSummary[] = [
  {
    id: 'gez-1',
    name: 'Agathe',
    role: 'Research Analyst',
    roleBasedName: 'research-analyst',
    poppetje: poppetjeFromSeed(3, { key: 'gez-1', name: 'Agathe' }),
    updatedAt: '',
  },
  {
    id: 'gez-2',
    name: 'Daouda',
    role: 'Slide Designer',
    roleBasedName: 'slide-designer',
    poppetje: poppetjeFromSeed(4, { key: 'gez-2', name: 'Daouda' }),
    updatedAt: '',
  },
];

const STEPS: TaskCraftbookStep[] = [
  { id: 's1', name: 'Acquire and verify sources', createdAt: '', suggestedGezelId: 'gez-1' },
  {
    id: 's2',
    name: 'Lock the slide outline',
    createdAt: '',
    assignee: { kind: 'gezel', gezelId: 'gez-2' },
  },
];

function renderTracker() {
  return render(
    <TaskStepTracker
      steps={STEPS}
      activeStepId="s1"
      selectedStepId="s1"
      onSelect={() => {}}
      onAddStep={() => {}}
      gezels={GEZELS}
      onAssign={() => {}}
    />,
  );
}

describe('TaskStepTracker assignee picker', () => {
  beforeEach(() => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      roleBasedNameOnlyMode: false,
      showPoppetjes: false,
    } as ConfigResponse);
  });

  it('labels the picker with friendly names by default', async () => {
    renderTracker();

    const picker = await screen.findByRole('combobox', {
      name: 'Assignee for Acquire and verify sources',
    });
    await waitFor(() => expect(within(picker).getByText('inherit · Agathe')).toBeInTheDocument());
    expect(within(picker).getByText('Daouda · Slide Designer')).toBeInTheDocument();
  });

  it('labels the picker with role-based names in boring mode', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      roleBasedNameOnlyMode: true,
      showPoppetjes: false,
    } as ConfigResponse);

    renderTracker();

    const picker = await screen.findByRole('combobox', {
      name: 'Assignee for Acquire and verify sources',
    });
    await waitFor(() =>
      expect(within(picker).getByText('inherit · research-analyst')).toBeInTheDocument(),
    );
    expect(within(picker).getByText('slide-designer')).toBeInTheDocument();
    expect(within(picker).queryByText(/Daouda/)).toBeNull();
  });
});
