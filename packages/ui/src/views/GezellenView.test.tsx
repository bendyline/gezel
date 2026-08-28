/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type GezelDetail, type GezelSummary, pickRandomNameWithGender } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

const appShellCss = readFileSync(resolve(process.cwd(), 'src/styles/app-shell.css'), 'utf8');

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

vi.mock('../components/CatalogBrowser.js', () => ({
  CatalogBrowser: () => <div data-testid="catalog-browser">browser</div>,
}));
vi.mock('../components/GezelIcon.js', () => ({
  // Don't render `name` as text content — the row already shows the
  // gezel name and we don't want `getByText('Maya')` to match twice.
  GezelIcon: ({ name }: { name: string }) => (
    <span data-testid="gezel-icon" data-gezel-name={name} />
  ),
}));
vi.mock('./GezelDetail.js', () => ({
  GezelDetail: ({ gezelId }: { gezelId: string }) => (
    <div data-testid="gezel-detail">{gezelId}</div>
  ),
}));

// Stable name + gender for the create dialog so tests don't depend on randomness.
vi.mock('@bendyline/gezel', async () => {
  const actual = await vi.importActual<typeof import('@bendyline/gezel')>('@bendyline/gezel');
  return {
    ...actual,
    pickRandomName: () => 'Ada',
    pickRandomNameWithGender: vi.fn(() => ({ name: 'Ada', gender: 'female' as const })),
  };
});

const { GezellenView } = await import('./GezellenView.js');
const { api } = await import('../api.js');

const GEZELS: GezelSummary[] = [
  { id: 'gz-1', name: 'Maya', role: 'Researcher' } as GezelSummary,
  { id: 'gz-2', name: 'Bob' } as GezelSummary,
];

describe('GezellenView', () => {
  beforeEach(() => {
    vi.mocked(pickRandomNameWithGender)
      .mockReset()
      .mockReturnValue({ name: 'Ada', gender: 'female' });
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: GEZELS } as never);
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'gz-1',
    } as never);
    vi.mocked(api.createGezel).mockResolvedValue({
      id: 'gz-new',
      name: 'Ada',
    } as unknown as GezelDetail);
    vi.mocked(api.generateGezelIcon).mockResolvedValue({} as never);
    vi.mocked(api.generateGezelAbout).mockResolvedValue({} as never);
  });

  it('lists gezellen and auto-selects the first one in the detail pane', async () => {
    render(<GezellenView />);
    await waitFor(() => {
      expect(screen.getByText('Maya')).toBeInTheDocument();
    });
    expect(screen.getByText('Bob')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('gezel-detail')).toHaveTextContent('gz-1');
    });
  });

  it('shows which gezel is working in the full roster', async () => {
    render(<GezellenView activeProjectsByGezel={new Map([['gz-2', new Set(['p2'])]])} />);

    const working = await screen.findByRole('button', {
      name: 'Bob is working. Open gezel.',
    });
    expect(working.querySelectorAll('.project-row-thinking-dot')).toHaveLength(3);

    // The generic `.side` button recipe is full-width. If it matches this
    // compact status button, the flex row shrinks the gezel's name and role
    // down to zero width, leaving only their portrait visible.
    const fullWidthSidebarSelector =
      '.side li button:not(.project-actions-trigger):not(.gezel-actions-trigger):not(.project-row-thinking):not(.gezel-row)';
    expect(appShellCss.replaceAll(/\s/g, '')).toContain(
      `${fullWidthSidebarSelector.replaceAll(/\s/g, '')}{display:block;width:100%;`,
    );
    expect(working.matches(fullWidthSidebarSelector)).toBe(false);
  });

  it('labels a machine-shared gezel without implying their chats are shared', async () => {
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        {
          id: 'shared-ada',
          name: 'Ada',
          role: 'Developer',
          storageScope: 'machine-shared',
        } as GezelSummary,
      ],
    } as never);
    render(<GezellenView />);
    const badge = await screen.findByText('Shared');
    expect(badge).toHaveAttribute(
      'title',
      'Shared with accounts on this machine; chats and memories stay private',
    );
  });

  it('shows the meester ⭐ badge next to the configured Meester', async () => {
    render(<GezellenView />);
    await waitFor(() => {
      expect(screen.getByLabelText('Current Meester')).toBeInTheDocument();
    });
  });

  it('clicking another gezel changes the detail pane', async () => {
    render(<GezellenView />);
    await waitFor(() => {
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Bob').closest('button')!);
    await waitFor(() => {
      expect(screen.getByTestId('gezel-detail')).toHaveTextContent('gz-2');
    });
  });

  it('shows an actions menu on every gezel row', async () => {
    render(<GezellenView />);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Actions for/ })).toHaveLength(2);
    });
    expect(screen.getByRole('button', { name: 'Actions for Bob' })).toBeInTheDocument();
  });

  it('shows the empty placeholder when no gezellen exist', async () => {
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [] } as never);
    render(<GezellenView />);
    await waitFor(() => {
      expect(screen.getByText(/No gezellen yet/)).toBeInTheDocument();
    });
  });

  it('+ New Gezel opens a dialog and submitting calls createGezel', async () => {
    render(<GezellenView />);
    await waitFor(() => {
      expect(screen.getByText('Maya')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /\+ New Gezel/ }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 3, name: /New Gezel/ })).toBeInTheDocument();
    });

    // Fill the role field via its placeholder; the label-then-querySelector
    // approach grabs the wrong input because both Name and Role labels
    // contain inputs and the first-encountered one wins.
    const roleInput = screen.getByPlaceholderText(/Developer, Marketing/) as HTMLInputElement;
    await user.type(roleInput, 'Designer');
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      expect(api.createGezel).toHaveBeenCalledWith({
        name: 'Ada',
        gender: 'female',
        role: 'Designer',
      });
    });
  });

  it('updates the gender dropdown when a name reroll lands non-binary', async () => {
    vi.mocked(pickRandomNameWithGender)
      .mockReturnValueOnce({ name: 'Ada', gender: 'female' })
      .mockReturnValueOnce({ name: 'Robin', gender: 'non-binary' });
    render(<GezellenView />);
    await screen.findByText('Maya');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /\+ New Gezel/ }));
    await user.click(screen.getByRole('button', { name: 'Pick a random name' }));

    expect(screen.getByPlaceholderText('e.g. Ada')).toHaveValue('Robin');
    expect(screen.getByRole('combobox')).toHaveValue('non-binary');
  });

  it('the From template tab inside the New Gezel dialog shows the catalog browser', async () => {
    render(<GezellenView />);
    await waitFor(() => {
      expect(screen.getByText('Maya')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /\+ New Gezel/ }));
    await user.click(screen.getByRole('tab', { name: /From template/ }));

    await waitFor(() => {
      expect(screen.getByTestId('catalog-browser')).toBeInTheDocument();
    });
  });

  it('refreshes the listing on a gezel:gezel-updated window event', async () => {
    render(<GezellenView />);
    await waitFor(() => {
      expect(api.listGezels).toHaveBeenCalledTimes(1);
    });

    window.dispatchEvent(new CustomEvent('gezel:gezel-updated', { detail: { id: 'gz-1' } }));

    await waitFor(() => {
      expect(api.listGezels).toHaveBeenCalledTimes(2);
    });
  });

  it('removes a gezel deleted from another menu and selects a survivor', async () => {
    vi.mocked(api.listGezels)
      .mockResolvedValueOnce({ gezels: GEZELS } as never)
      .mockResolvedValue({ gezels: [GEZELS[1]] } as never);
    render(<GezellenView />);
    await waitFor(() => {
      expect(screen.getByTestId('gezel-detail')).toHaveTextContent('gz-1');
    });

    window.dispatchEvent(
      new CustomEvent('gezel:gezel-deleted', { detail: { gezelId: 'gz-1', name: 'Maya' } }),
    );

    await waitFor(() => {
      expect(screen.queryByText('Maya')).not.toBeInTheDocument();
      expect(screen.getByTestId('gezel-detail')).toHaveTextContent('gz-2');
    });
    expect(api.listGezels).toHaveBeenCalledTimes(2);
    expect(api.getConfig).toHaveBeenCalledTimes(2);
  });

  it('shows a friendly error chip when listGezels rejects', async () => {
    vi.mocked(api.listGezels).mockRejectedValue(new Error('out to lunch'));
    render(<GezellenView />);
    await waitFor(() => {
      expect(screen.getByText(/out to lunch/)).toBeInTheDocument();
    });
  });

  it('shows a level badge (with pending dot) from the inlined growth summary', async () => {
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        { id: 'gz-1', name: 'Maya', growth: { level: 4, pending: true } } as GezelSummary,
        // Level 1, nothing pending → no badge (unremarkable default).
        { id: 'gz-2', name: 'Bob', growth: { level: 1 } } as GezelSummary,
      ],
    } as never);
    render(<GezellenView />);
    await waitFor(() => {
      expect(screen.getByText('Lv 4')).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/a level-up is waiting/)).toBeInTheDocument();
    expect(screen.queryByText('Lv 1')).not.toBeInTheDocument();
  });

  it('refreshes the listing on a gezel:growth-updated window event', async () => {
    render(<GezellenView />);
    await waitFor(() => {
      expect(api.listGezels).toHaveBeenCalledTimes(1);
    });

    window.dispatchEvent(new CustomEvent('gezel:growth-updated', { detail: { gezelId: 'gz-1' } }));

    await waitFor(() => {
      expect(api.listGezels).toHaveBeenCalledTimes(2);
    });
  });
});
