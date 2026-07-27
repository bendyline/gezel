import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../components/CraftbookChatPane.js', () => ({
  CraftbookChatPane: () => <div>AI pane</div>,
}));
vi.mock('../components/CraftbookStepPanel.js', () => ({
  CraftbookStepPanel: () => <div>Step panel</div>,
}));
vi.mock('../components/MarkdownField.js', () => ({
  MarkdownField: () => <div>Description field</div>,
}));
vi.mock('../components/StepTracker.js', () => ({
  StepTracker: (props: { onAddStep?: () => void }) => (
    <div>
      Step tracker
      {props.onAddStep && (
        <button type="button" onClick={props.onAddStep}>
          Add step
        </button>
      )}
    </div>
  ),
}));

const { CraftbookEditor } = await import('./CraftbookEditor.js');
const { api } = await import('../api.js');

const craftbook = {
  id: 'review',
  name: 'Review changes',
  description: 'A careful review flow.',
  steps: [{ id: 'inspect', name: 'Inspect' }],
  entryStepId: 'inspect',
};

describe('CraftbookEditor', () => {
  beforeEach(() => {
    vi.mocked(api.getCraftbook).mockResolvedValue({ craftbook } as never);
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [] } as never);
    vi.mocked(api.listCraftbooks).mockResolvedValue({
      craftbooks: [{ id: 'review', source: 'local' }],
    } as never);
    vi.mocked(api.updateCraftbook).mockImplementation(
      async (_id, body) =>
        ({
          craftbook: { ...craftbook, ...body },
        }) as never,
    );
    vi.mocked(api.createCraftbook).mockResolvedValue({
      craftbook: { ...craftbook, id: 'review-copy', name: 'Review changes (copy)' },
    } as never);
  });

  it('loads a local craftbook and persists a renamed title', async () => {
    render(<CraftbookEditor craftbookId="review" source="local" />);
    const name = await screen.findByLabelText('Craftbook name');

    fireEvent.change(name, { target: { value: 'Release review' } });
    fireEvent.blur(name);

    await waitFor(() => {
      expect(api.updateCraftbook).toHaveBeenCalledWith(
        'review',
        expect.objectContaining({ name: 'Release review', entryStepId: 'inspect' }),
      );
    });
    expect(screen.getByText('Step panel')).toBeInTheDocument();
  });

  it('adds a uniquely identified step to an editable craftbook', async () => {
    render(<CraftbookEditor craftbookId="review" source="local" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add step' }));

    await waitFor(() => {
      expect(api.updateCraftbook).toHaveBeenCalledWith(
        'review',
        expect.objectContaining({
          steps: [
            { id: 'inspect', name: 'Inspect' },
            expect.objectContaining({ name: 'New step' }),
          ],
        }),
      );
    });
  });

  it('forks a bundled craftbook into a new editable tab', async () => {
    const openTab = vi.fn();
    window.addEventListener('gezel:open-tab', openTab);
    render(<CraftbookEditor craftbookId="review" source="bundled" />);

    expect(await screen.findByRole('heading', { name: 'Review changes' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Craftbook name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy to edit' }));

    await waitFor(() => expect(api.createCraftbook).toHaveBeenCalled());
    expect((openTab.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      kind: 'craftbook',
      id: 'review-copy',
      source: 'local',
    });
    window.removeEventListener('gezel:open-tab', openTab);
  });
});
