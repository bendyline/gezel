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
    expect(screen.getByText('Opens in the project')).toBeInTheDocument();
    expect(screen.queryByText('trip.json')).not.toBeInTheDocument();
  });

  // A catering proposal read `report.docx`, "In the artifacts drawer · tasks/2".
  it('leads with what the person asked for and keeps the path out of sight', () => {
    render(
      <DeliverableCard
        deliverable={{
          kind: 'artifact',
          path: 'tasks/2/report.docx',
          bytes: 16_180,
          modifiedAt: new Date(Date.now() - 120_000).toISOString(),
        }}
        projectId="default"
        onOpen={vi.fn()}
        title="One-page catering proposal for Harbor Books"
      />,
    );
    const card = screen.getByTestId('deliverable-card');
    expect(card.querySelector('.deliverable-card-name')).toHaveTextContent(
      'One-page catering proposal for Harbor Books',
    );
    expect(card.querySelector('.deliverable-card-meta')?.textContent).toMatch(
      /^report\.docx · 15\.8 KB · /,
    );
    expect(screen.getByText('report.docx')).toHaveAttribute('title', 'tasks/2/report.docx');
    expect(card).not.toHaveTextContent(/artifacts drawer|project folder|tasks\/2/);
  });

  it('keeps the file name as the main line when the work has no title of its own', () => {
    render(
      <DeliverableCard
        deliverable={{ kind: 'workspace', path: 'reports/q3/summary.pdf', bytes: 2048 }}
        projectId="default"
        onOpen={vi.fn()}
      />,
    );
    const card = screen.getByTestId('deliverable-card');
    expect(card.querySelector('.deliverable-card-name')).toHaveTextContent('summary.pdf');
    expect(screen.getByText('summary.pdf')).toHaveAttribute('title', 'reports/q3/summary.pdf');
    expect(card.querySelector('.deliverable-card-meta')).toHaveTextContent(/^2\.0 KB$/);
  });

  it("offers the work's title as the name of a saved copy", async () => {
    const saveReferenceCopy = vi.fn().mockResolvedValue({ ok: true });
    window.__GEZEL__ = { token: 't', saveReferenceCopy } as unknown as typeof window.__GEZEL__;
    try {
      const { rerender } = render(
        <DeliverableCard
          deliverable={{ kind: 'artifact', path: 'tasks/2/report.docx' }}
          projectId="default"
          title="Q3: plan/review for Harbor Books"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save a copy…' }));
      await waitFor(() =>
        expect(saveReferenceCopy).toHaveBeenLastCalledWith({
          projectId: 'default',
          kind: 'artifact',
          path: 'tasks/2/report.docx',
          suggestedName: 'Q3 plan review for Harbor Books.docx',
        }),
      );

      // Without a title the dialog keeps offering the file's own name.
      rerender(
        <DeliverableCard
          deliverable={{ kind: 'artifact', path: 'tasks/2/report.docx' }}
          projectId="default"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save a copy…' }));
      await waitFor(() =>
        expect(saveReferenceCopy).toHaveBeenLastCalledWith({
          projectId: 'default',
          kind: 'artifact',
          path: 'tasks/2/report.docx',
        }),
      );
    } finally {
      window.__GEZEL__ = undefined;
    }
  });
});
