import type { SecurityPolicy, ToolCallCard } from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const { listProjectCraftbooks, getConfig } = vi.hoisted(() => ({
  listProjectCraftbooks: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock('../api.js', () => ({
  api: createMockApi({
    listProjectCraftbooks,
    getConfig,
  }),
}));

const { ToolCraftbookCard } = await import('./ToolCraftbookCard.js');
const { takePendingSettingsSection } = await import('../settings-nav.js');

const FREE_POLICY: SecurityPolicy = {
  level: 'free',
  allowFileEdits: true,
  allowExternalChat: true,
  allowExternalServices: true,
  allowScriptExecution: true,
  allowAppNetwork: true,
};

/** Distinct projectId per test dodges the component's module-level listing cache. */
let projectSeq = 0;
function startCard(overrides?: Partial<Extract<ToolCallCard, { kind: 'craftbook-start' }>>) {
  projectSeq += 1;
  return {
    kind: 'craftbook-start',
    craftbookId: 'powerpoint-deck',
    craftbookName: 'PowerPoint from Content',
    taskRef: 'default/12',
    projectId: `proj-${projectSeq}`,
    status: 'active',
    activeStepId: 'research',
    steps: [
      { id: 'research', name: 'Acquire and verify sources', status: 'active' as const },
      { id: 'outline', name: 'Lock the slide outline', status: 'pending' as const },
    ],
    ...overrides,
  } satisfies ToolCallCard;
}

beforeEach(() => {
  listProjectCraftbooks.mockReset().mockResolvedValue({ items: [], missingToolsets: {} });
  getConfig.mockReset().mockResolvedValue({});
  takePendingSettingsSection();
});

describe('ToolCraftbookCard — craftbook start', () => {
  it('renders the eyebrow, headline, roadmap snapshot, and task chip', async () => {
    const onFocusTask = vi.fn();
    render(<ToolCraftbookCard card={startCard()} onFocusTask={onFocusTask} />);

    expect(screen.getByText('Craftbook started')).toBeInTheDocument();
    expect(screen.getByText('PowerPoint from Content is underway — 2 steps.')).toBeInTheDocument();
    expect(screen.getByText('Acquire and verify sources')).toBeInTheDocument();
    expect(screen.getByText('Lock the slide outline')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Task default/12' }));
    expect(onFocusTask).toHaveBeenCalledWith('default/12');
  });

  it('falls back to the full task tab when no rail opener is wired', async () => {
    let opened: unknown;
    const onOpenTab = (event: Event) => {
      opened = (event as CustomEvent).detail;
    };
    window.addEventListener('gezel:open-tab', onOpenTab);
    render(<ToolCraftbookCard card={startCard()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Task default/12' }));
    expect(opened).toEqual({ kind: 'task', ref: 'default/12' });
    window.removeEventListener('gezel:open-tab', onOpenTab);
  });

  it('marks an idempotent re-invocation', () => {
    render(<ToolCraftbookCard card={startCard({ reused: true })} />);
    expect(screen.getByText('Craftbook already running')).toBeInTheDocument();
  });

  it('nudges toward External services only while the policy disables it, and deep-links to Settings', async () => {
    // Default config = no securityPolicy = lockdown = External services OFF.
    let navigation: unknown;
    const onNavigate = (event: Event) => {
      navigation = (event as CustomEvent).detail;
    };
    window.addEventListener('gezel:navigate', onNavigate);
    render(
      <ToolCraftbookCard
        card={startCard({
          recommendsExternalServices: { reason: 'verifies sources with live web search' },
        })}
      />,
    );

    const nudge = await screen.findByText(/verifies sources with live web search/);
    expect(nudge).toHaveTextContent('It still runs without it.');

    fireEvent.click(screen.getByRole('button', { name: 'Review in Settings' }));
    expect(takePendingSettingsSection()).toBe('securityCompliance');
    expect(navigation).toEqual({ view: 'settings', section: 'securityCompliance' });
    window.removeEventListener('gezel:navigate', onNavigate);

    // The user flips the toggle — the card hears the config update and
    // stops nudging toward a switch that is already on.
    getConfig.mockResolvedValue({ securityPolicy: FREE_POLICY });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('gezel:config-updated', { detail: { securityPolicy: FREE_POLICY } }),
      );
    });
    await waitFor(() =>
      expect(screen.queryByText(/verifies sources with live web search/)).not.toBeInTheDocument(),
    );
  });

  it('shows no nudge when the craftbook declares no recommendation', () => {
    render(<ToolCraftbookCard card={startCard()} />);
    expect(screen.queryByText(/External services/)).not.toBeInTheDocument();
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('shows no nudge when External services is already enabled', async () => {
    getConfig.mockResolvedValue({ securityPolicy: FREE_POLICY });
    render(<ToolCraftbookCard card={startCard({ recommendsExternalServices: {} })} />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    expect(screen.queryByText(/External services/)).not.toBeInTheDocument();
  });
});

describe('ToolCraftbookCard — step advance', () => {
  it('renders the slim variant with the moved tracker', () => {
    const { container } = render(
      <ToolCraftbookCard
        card={{
          kind: 'task-step-advance',
          craftbookId: 'powerpoint-deck',
          craftbookName: 'PowerPoint from Content',
          taskRef: 'default/12',
          projectId: `proj-adv-${projectSeq}`,
          status: 'active',
          completedStepId: 'research',
          completedStepName: 'Acquire and verify sources',
          activeStepId: 'outline',
          activeStepName: 'Lock the slide outline',
          steps: [
            { id: 'research', name: 'Acquire and verify sources', status: 'done' },
            { id: 'outline', name: 'Lock the slide outline', status: 'active' },
          ],
        }}
      />,
    );

    expect(screen.getByText('Step complete')).toBeInTheDocument();
    expect(
      screen.getByText('Completed “Acquire and verify sources” — now on “Lock the slide outline”.'),
    ).toBeInTheDocument();
    expect(container.querySelector('.msg-tool-card-compact')).not.toBeNull();
  });

  it('says so when the advance finished the task', () => {
    render(
      <ToolCraftbookCard
        card={{
          kind: 'task-step-advance',
          craftbookId: 'ship',
          craftbookName: 'Ship',
          taskRef: 'default/3',
          projectId: `proj-done-${projectSeq}`,
          status: 'complete',
          completedStepId: 'finish',
          completedStepName: 'Finish',
          steps: [{ id: 'finish', name: 'Finish', status: 'done' }],
        }}
      />,
    );
    expect(screen.getByText('Completed “Finish” — task complete.')).toBeInTheDocument();
  });
});
