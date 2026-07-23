import type {
  GezelDetail as GezelDetailData,
  GezelGrowthResponse,
  GezelGrowthState,
} from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));
vi.mock('../poppetje/index.js', () => ({
  Poppetje: () => <span data-testid="poppetje" />,
}));

const { GrowthPanel } = await import('./GrowthPanel.js');
const { api } = await import('../api.js');

const GEZEL = {
  id: 'gz-maya',
  name: 'Maya',
  icon: null,
  poppetje: null,
} as unknown as GezelDetailData;

function growthState(overrides: Partial<GezelGrowthState> = {}): GezelGrowthState {
  return {
    version: 1,
    level: 1,
    xp: 0,
    signals: { memoryXp: 0, lessonsXp: 0, taskXp: 0, consultXp: 0 },
    adoptedTraits: [],
    declinedProposals: [],
    unlockedCosmetics: [],
    ...overrides,
  };
}

function growthResponse(overrides: Partial<GezelGrowthResponse> = {}): GezelGrowthResponse {
  return {
    state: growthState(),
    nextLevelXp: 100,
    activeTraits: [],
    driftedTraitIds: [],
    ...overrides,
  };
}

const PENDING = growthResponse({
  state: growthState({
    level: 2,
    xp: 260,
    signals: { memoryXp: 200, lessonsXp: 30, taskXp: 25, consultXp: 5 },
    pendingLevelUp: {
      toLevel: 3,
      proposals: [
        {
          id: 'prop-a',
          kind: 'trait',
          title: 'Comment style',
          traitText: 'Keep comments sparse — explain why, never what.',
          evidence: [
            {
              day: '2026-06-01',
              kind: 'pref',
              excerpt: 'User prefers sparse comments that explain why.',
            },
          ],
        },
        {
          id: 'prop-temp',
          kind: 'tuning',
          title: 'Run warmer',
          description: 'Nudge temperature up a notch.',
          action: { type: 'temperature', delta: 0.1 },
        },
        { id: 'prop-cos', kind: 'cosmetic', title: 'Straw hat', cosmeticId: 'hat.straw' },
      ],
      createdAt: '2026-06-10T00:00:00Z',
    },
  }),
  nextLevelXp: 250,
});

describe('GrowthPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(api.getGezelGrowth).mockResolvedValue(growthResponse());
    vi.mocked(api.getGezel).mockResolvedValue(GEZEL);
  });

  it('renders the level-1 invitation empty state', async () => {
    render(<GrowthPanel gezel={GEZEL} />);
    await waitFor(() => {
      expect(screen.getByText(/Growth here is earned, not simulated/)).toBeInTheDocument();
    });
    expect(screen.getByText('Future trait slot')).toBeInTheDocument();
    expect(screen.queryByText(/reached level/)).not.toBeInTheDocument();
  });

  it('renders XP progress and signal counters at mid-level', async () => {
    vi.mocked(api.getGezelGrowth).mockResolvedValue(
      growthResponse({
        state: growthState({
          level: 2,
          xp: 150,
          signals: { memoryXp: 100, lessonsXp: 30, taskXp: 15, consultXp: 5 },
        }),
        nextLevelXp: 250,
      }),
    );
    render(<GrowthPanel gezel={GEZEL} />);
    await waitFor(() => {
      expect(screen.getByText('Maya · Level 2')).toBeInTheDocument();
    });
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByText('Memories')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText(/100 to level 3/)).toBeInTheDocument();
  });

  it('shows the level-up banner with evidence and accepts a proposal', async () => {
    vi.mocked(api.getGezelGrowth).mockResolvedValue(PENDING);
    const accepted = growthResponse({
      state: growthState({ level: 3, xp: 260 }),
      nextLevelXp: 500,
      activeTraits: [
        {
          id: 'trait-a',
          text: 'Keep comments sparse — explain why, never what.',
          adoptedAt: '2026-06-11T00:00:00Z',
          source: 'levelup',
        },
      ],
    });
    let resolveAccept!: (v: GezelGrowthResponse) => void;
    vi.mocked(api.acceptGrowthProposal).mockReturnValue(
      new Promise<GezelGrowthResponse>((r) => {
        resolveAccept = r;
      }),
    );

    render(<GrowthPanel gezel={GEZEL} />);
    await waitFor(() => {
      expect(screen.getByText('Maya reached level 3.')).toBeInTheDocument();
    });
    // Evidence quoted verbatim on the trait card.
    expect(screen.getByText(/User prefers sparse comments that explain why./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Adopt this trait' }));
    expect(api.acceptGrowthProposal).toHaveBeenCalledWith('gz-maya', 'prop-a');
    // Sibling cards lock while the accept is in flight.
    expect(screen.getByRole('button', { name: 'Run a little warmer' })).toBeDisabled();

    resolveAccept(accepted);
    await waitFor(() => {
      expect(screen.getByText('Maya · Level 3')).toBeInTheDocument();
    });
    // Banner resolved; the adopted trait is on the character sheet.
    expect(screen.queryByText('Maya reached level 3.')).not.toBeInTheDocument();
    expect(screen.getByText('Keep comments sparse — explain why, never what.')).toBeInTheDocument();
    // Frontmatter changed server-side → fresh detail broadcast for other surfaces.
    await waitFor(() => {
      expect(api.getGezel).toHaveBeenCalledWith('gz-maya');
    });
  });

  it('skips a whole level through the confirm dialog', async () => {
    vi.mocked(api.getGezelGrowth).mockResolvedValue(PENDING);
    vi.mocked(api.declineGrowthLevelUp).mockResolvedValue(
      growthResponse({ state: growthState({ level: 3, xp: 260 }), nextLevelXp: 500 }),
    );

    render(<GrowthPanel gezel={GEZEL} />);
    await waitFor(() => {
      expect(screen.getByText('Maya reached level 3.')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Skip this level' }));
    // ConfirmDialog opens; its action button carries the same label.
    const confirm = screen
      .getAllByRole('button', { name: 'Skip this level' })
      .find((b) => b.classList.contains('primary'));
    expect(confirm).toBeTruthy();
    fireEvent.click(confirm!);

    await waitFor(() => {
      expect(api.declineGrowthLevelUp).toHaveBeenCalledWith('gz-maya');
    });
    await waitFor(() => {
      expect(screen.queryByText('Maya reached level 3.')).not.toBeInTheDocument();
    });
  });

  it('declines a single proposal without resolving the level-up', async () => {
    vi.mocked(api.getGezelGrowth).mockResolvedValue(PENDING);
    vi.mocked(api.declineGrowthLevelUp).mockResolvedValue(PENDING);

    render(<GrowthPanel gezel={GEZEL} />);
    await waitFor(() => {
      expect(screen.getByText('Maya reached level 3.')).toBeInTheDocument();
    });
    const declineButtons = screen.getAllByRole('button', { name: 'Not this one' });
    expect(declineButtons.length).toBe(3);
    fireEvent.click(declineButtons[0]!);
    await waitFor(() => {
      expect(api.declineGrowthLevelUp).toHaveBeenCalledWith('gz-maya', 'prop-a');
    });
  });

  it('retires an adopted trait through the confirm dialog', async () => {
    const withTrait = growthResponse({
      state: growthState({
        level: 2,
        xp: 150,
        adoptedTraits: [
          {
            traitId: 'trait-a',
            text: 'Always run the tests first.',
            level: 2,
            adoptedAt: '2026-06-01T00:00:00Z',
            evidence: [{ day: '2026-05-30', kind: 'decision', excerpt: 'Run tests before done.' }],
          },
        ],
      }),
      nextLevelXp: 250,
      activeTraits: [
        {
          id: 'trait-a',
          text: 'Always run the tests first.',
          adoptedAt: '2026-06-01T00:00:00Z',
          source: 'levelup',
        },
      ],
    });
    vi.mocked(api.getGezelGrowth).mockResolvedValue(withTrait);
    vi.mocked(api.retireGrowthTrait).mockResolvedValue(
      growthResponse({ state: growthState({ level: 2, xp: 150 }), nextLevelXp: 250 }),
    );

    render(<GrowthPanel gezel={GEZEL} />);
    await waitFor(() => {
      expect(screen.getByText('Always run the tests first.')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retire this trait' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    await waitFor(() => {
      expect(api.retireGrowthTrait).toHaveBeenCalledWith('gz-maya', 'trait-a');
    });
  });

  it('warns when adopted traits drifted out of frontmatter', async () => {
    vi.mocked(api.getGezelGrowth).mockResolvedValue(
      growthResponse({
        state: growthState({ level: 2, xp: 150 }),
        nextLevelXp: 250,
        driftedTraitIds: ['trait-gone'],
      }),
    );
    render(<GrowthPanel gezel={GEZEL} />);
    await waitFor(() => {
      expect(screen.getByText(/no longer in Maya's frontmatter/)).toBeInTheDocument();
    });
  });
});
