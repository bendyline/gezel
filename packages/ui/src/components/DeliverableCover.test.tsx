import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="portrait" data-name={name} />,
}));

const { api } = await import('../api.js');
const { readCoverText } = await import('./DeliverableCover.js');
const { DeliverableCard } = await import('./DeliverableCard.js');

describe('readCoverText', () => {
  it('takes the heading and the opening lines, without markdown marks', () => {
    expect(
      readCoverText(
        '---\ntitle: x\n---\n# Ten days in Portugal\n\n**Lisbon** first, then the [Algarve](a.md).\n- Pack sunscreen\n1. Book the train\n',
      ),
    ).toEqual({
      title: 'Ten days in Portugal',
      lines: ['Lisbon first, then the Algarve.', '• Pack sunscreen', 'Book the train'],
    });
  });
});

describe('the finished-work card', () => {
  const deliverable = {
    kind: 'workspace' as const,
    path: 'family-trip.md',
    projectId: 'trip',
  };

  it('credits the maker, shows the first page, and offers changes', async () => {
    vi.mocked(api.readProjectWorkspaceFile).mockResolvedValue({
      path: 'family-trip.md',
      content: '# Ten days in Portugal\nLisbon first.\n',
    } as never);
    const onMakeChanges = vi.fn();
    render(
      <DeliverableCard
        deliverable={deliverable}
        projectId="trip"
        onOpen={vi.fn()}
        maker={{ name: 'Mira' }}
        onMakeChanges={onMakeChanges}
      />,
    );
    expect(screen.getByText('made this for you')).toBeInTheDocument();
    expect(screen.getByTestId('portrait')).toHaveAttribute('data-name', 'Mira');
    await waitFor(() => expect(screen.getByText('Ten days in Portugal')).toBeInTheDocument());
    expect(api.readProjectWorkspaceFile).toHaveBeenCalledWith('trip', 'family-trip.md');
    // The cover only enlarges the pointer target; the face is the one named key.
    const cover = screen.getByText('Ten days in Portugal').closest('button');
    expect(cover).toHaveAttribute('tabindex', '-1');
    expect(cover).toHaveAttribute('aria-hidden', 'true');
    const openKeys = screen.getAllByRole('button').filter((b) => b.title.startsWith('Open '));
    expect(openKeys).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Make changes' }));
    expect(onMakeChanges).toHaveBeenCalled();
  });

  it('opens a project board as the board, not as its JSON', () => {
    const onOpen = vi.fn();
    render(
      <DeliverableCard
        deliverable={{
          kind: 'workspace',
          path: 'trip.json',
          projectId: 'trip',
          view: 'output-page',
        }}
        projectId="trip"
        onOpen={onOpen}
        projectName="Trip: Portugal"
      />,
    );
    expect(screen.getByText('Trip: Portugal')).toBeInTheDocument();
    expect(screen.getByText("The project's Output page")).toBeInTheDocument();
    expect(screen.queryByText('trip.json')).not.toBeInTheDocument();
  });
});
