import { type GezelSummary, type TaskCraftbookStep, poppetjeFromSeed } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeAll(() => {
    Object.defineProperties(HTMLElement.prototype, {
      hasPointerCapture: { configurable: true, value: () => false },
      setPointerCapture: { configurable: true, value: () => {} },
      releasePointerCapture: { configurable: true, value: () => {} },
      scrollIntoView: { configurable: true, value: () => {} },
    });
  });

  afterAll(() => {
    delete (HTMLElement.prototype as { hasPointerCapture?: unknown }).hasPointerCapture;
    delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    delete (HTMLElement.prototype as { releasePointerCapture?: unknown }).releasePointerCapture;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  beforeEach(() => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      roleBasedNameOnlyMode: false,
      showPoppetjes: false,
    } as ConfigResponse);
  });

  it('labels the picker with friendly names by default', async () => {
    const user = userEvent.setup();
    renderTracker();

    const picker = await screen.findByRole('combobox', {
      name: 'Assignee for Acquire and verify sources',
    });
    await waitFor(() => expect(within(picker).getByText('Agathe (default)')).toBeInTheDocument());
    await user.click(picker);
    expect(
      await screen.findByRole('option', { name: 'Daouda · Slide Designer' }),
    ).toBeInTheDocument();
  });

  it('labels the picker with role-based names in boring mode', async () => {
    const user = userEvent.setup();
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
      expect(within(picker).getByText('research-analyst (default)')).toBeInTheDocument(),
    );
    await user.click(picker);
    expect(await screen.findByRole('option', { name: 'slide-designer' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Daouda/ })).toBeNull();
  });
});
