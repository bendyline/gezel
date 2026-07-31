import type { SuggestedWorkItem } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { SuggestedNightWork } = await import('./SuggestedNightWork.js');
const { api } = await import('../api.js');

function makeItem(overrides: Partial<SuggestedWorkItem> = {}): SuggestedWorkItem {
  return {
    key: 'gezel-template:veiligheidsmeester:security-code-review',
    source: {
      kind: 'gezel-template',
      templateId: 'veiligheidsmeester',
      gezelId: 'gz-rik',
      gezelName: 'Rik',
      role: 'Chief Security Officer',
    },
    craftbookId: 'security-code-review',
    craftbookName: 'Security Code Review',
    reason: 'Keeps an eye on new code overnight.',
    runMode: 'night-shift',
    state: 'suggested',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(api.listSuggestedWork).mockReset();
  vi.mocked(api.enableSuggestedWork).mockReset();
  vi.mocked(api.disableSuggestedWork).mockReset();
  vi.mocked(api.dismissSuggestedWork).mockReset();
});

describe('SuggestedNightWork', () => {
  it('renders nothing when there are no suggestions', async () => {
    vi.mocked(api.listSuggestedWork).mockResolvedValue({ items: [] });
    const { container } = render(<SuggestedNightWork projectId="p1" />);
    await waitFor(() => expect(api.listSuggestedWork).toHaveBeenCalledWith('p1'));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a suggested row with sponsor and enables it on click', async () => {
    vi.mocked(api.listSuggestedWork)
      .mockResolvedValueOnce({ items: [makeItem()] })
      .mockResolvedValueOnce({
        items: [makeItem({ state: 'enabled', taskRef: 'p1/3' })],
      });
    vi.mocked(api.enableSuggestedWork).mockResolvedValue({
      item: makeItem({ state: 'enabled', taskRef: 'p1/3' }),
      task: { ref: 'p1/3' } as never,
    });

    render(<SuggestedNightWork projectId="p1" />);
    expect(await screen.findByText(/Security Code Review/)).toBeInTheDocument();
    expect(screen.getByText(/Suggested by Rik/)).toBeInTheDocument();
    expect(screen.getByText(/Night Shift window/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() =>
      expect(api.enableSuggestedWork).toHaveBeenCalledWith('p1', {
        key: 'gezel-template:veiligheidsmeester:security-code-review',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('pauses an enabled row', async () => {
    vi.mocked(api.listSuggestedWork).mockResolvedValue({
      items: [makeItem({ state: 'enabled', taskRef: 'p1/3' })],
    });
    vi.mocked(api.disableSuggestedWork).mockResolvedValue({
      item: makeItem({ state: 'paused', taskRef: 'p1/3' }),
    });

    render(<SuggestedNightWork projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(api.disableSuggestedWork).toHaveBeenCalledWith(
        'p1',
        'gezel-template:veiligheidsmeester:security-code-review',
      ),
    );
  });

  it('dismisses a suggestion and reveals it under the hidden reveal', async () => {
    vi.mocked(api.listSuggestedWork)
      .mockResolvedValueOnce({ items: [makeItem()] })
      .mockResolvedValueOnce({ items: [makeItem({ state: 'dismissed' })] });
    vi.mocked(api.dismissSuggestedWork).mockResolvedValue({ ok: true });

    render(<SuggestedNightWork projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: "Don't suggest" }));
    await waitFor(() =>
      expect(api.dismissSuggestedWork).toHaveBeenCalledWith(
        'p1',
        'gezel-template:veiligheidsmeester:security-code-review',
        true,
      ),
    );
    const reveal = await screen.findByRole('button', { name: /1 hidden suggestion/ });
    fireEvent.click(reveal);
    expect(screen.getByRole('button', { name: 'Suggest again' })).toBeInTheDocument();
  });

  it('opens the param form when the craftbook declares params, seeding from project properties', async () => {
    vi.mocked(api.listSuggestedWork).mockResolvedValue({
      items: [
        makeItem({
          key: 'gezel-template:vertaler:translate-content',
          craftbookId: 'translate-content',
          craftbookName: 'Translate Content',
          paramSchema: {
            type: 'object',
            properties: {
              language: { type: 'string', projectProperty: 'content.language' },
            },
          },
        }),
      ],
    });
    vi.mocked(api.enableSuggestedWork).mockResolvedValue({
      item: makeItem({ state: 'enabled' }),
      task: { ref: 'p1/4' } as never,
    });
    vi.mocked(api.updateProject).mockResolvedValue({} as never);

    render(
      <SuggestedNightWork
        projectId="p1"
        projectProperties={{ 'content.language': 'Nederlands' }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    // The inline form appears instead of enabling immediately; its primary
    // submit sits alongside the row's (now disabled) Enable button.
    expect(api.enableSuggestedWork).not.toHaveBeenCalled();
    const submit = await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: 'Enable' });
      const primary = buttons.find((b) => b.classList.contains('primary'));
      if (!primary) throw new Error('param form submit not rendered yet');
      return primary;
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.enableSuggestedWork).toHaveBeenCalledWith('p1', {
        key: 'gezel-template:vertaler:translate-content',
        params: { language: 'Nederlands' },
      }),
    );
    // The annotated param writes back to the shared project property.
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('p1', {
        properties: { 'content.language': 'Nederlands' },
      }),
    );
  });
});
