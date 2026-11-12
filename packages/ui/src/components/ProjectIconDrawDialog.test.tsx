import type { ProjectDetail } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { ProjectIconDrawDialog } = await import('./ProjectIconDrawDialog.js');
const { api } = await import('../api.js');

const mark = (d: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="${d}"/></svg>`;
const LEAF = mark('M4 20c0-8 6-14 16-16');
const PEAR = mark('M12 3v4m-4 6a4 4 0 0 0 8 0');
const project = { id: 'orchard', name: 'Orchard' };
const BRIEF = 'Something that stands for “Orchard”. One idea: a seedling.';

function open(props: Partial<Parameters<typeof ProjectIconDrawDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <ProjectIconDrawDialog
      open
      project={project}
      defaultDescription={BRIEF}
      onClose={onClose}
      onSaved={onSaved}
      {...props}
    />,
  );
  return { onClose, onSaved };
}

const brief = () => screen.getByLabelText('What should it show?') as HTMLTextAreaElement;
const generate = () => screen.getByRole('button', { name: /^Generate/ });
const keep = () =>
  screen.getByRole('button', { name: 'Set this as the icon' }) as HTMLButtonElement;

describe('ProjectIconDrawDialog', () => {
  beforeEach(() => {
    vi.mocked(api.drawProjectIcon).mockReset();
    vi.mocked(api.setProjectIconSvg).mockReset();
  });

  it('opens with the description filled in, and nothing to keep yet', () => {
    open();
    expect(brief().value).toBe(BRIEF);
    expect(keep().disabled).toBe(true);
    expect(screen.getByTestId('project-icon-draw-preview')).toHaveTextContent('Nothing drawn yet.');
    expect(api.drawProjectIcon).not.toHaveBeenCalled();
  });

  it('draws from the description as the person left it', async () => {
    vi.mocked(api.drawProjectIcon).mockResolvedValue({ svg: LEAF });
    open();
    fireEvent.change(brief(), { target: { value: '  A pear leaf, thick lines.  ' } });
    await act(async () => {
      fireEvent.click(generate());
    });
    expect(vi.mocked(api.drawProjectIcon).mock.calls[0]?.slice(0, 2)).toEqual([
      'orchard',
      { description: 'A pear leaf, thick lines.' },
    ]);
    await waitFor(() => expect(keep().disabled).toBe(false));
    expect(
      screen.getByTestId('project-icon-draw-preview').querySelector('.project-icon-drawn'),
    ).not.toBeNull();
    // The same mark at list size, beside the project's name.
    expect(document.querySelector('.project-icon-draw-in-list')).toHaveTextContent('Orchard');
  });

  it('keeps every drawing made, and saves the one that is chosen', async () => {
    vi.mocked(api.drawProjectIcon)
      .mockResolvedValueOnce({ svg: LEAF })
      .mockResolvedValueOnce({ svg: PEAR });
    const saved = { id: 'orchard', name: 'Orchard' } as ProjectDetail;
    vi.mocked(api.setProjectIconSvg).mockResolvedValue(saved);
    const { onClose, onSaved } = open();

    await act(async () => {
      fireEvent.click(generate());
    });
    expect(screen.queryByRole('radiogroup', { name: 'Drawings so far' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Generate another' }));
    });
    const attempts = screen.getAllByRole('radio');
    expect(attempts).toHaveLength(2);
    // The newest is the one in hand.
    expect(attempts[1]).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('radio', { name: 'Drawing 1' }));
    await act(async () => {
      fireEvent.click(keep());
    });
    expect(api.setProjectIconSvg).toHaveBeenCalledWith('orchard', { svg: LEAF });
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(onClose).toHaveBeenCalled();
  });

  it('saves nothing when the person cancels', async () => {
    vi.mocked(api.drawProjectIcon).mockResolvedValue({ svg: LEAF });
    const { onClose, onSaved } = open();
    await act(async () => {
      fireEvent.click(generate());
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.setProjectIconSvg).not.toHaveBeenCalled();
  });

  it("shows the daemon's own sentence when a drawing fails, and lets the person try again", async () => {
    vi.mocked(api.drawProjectIcon).mockRejectedValueOnce(
      new GezelApiError('Gezel API error 422 on POST /api/projects/orchard/icon/draw', 422, {
        error: 'The model did not return a usable icon. Try again, or change the description.',
      }),
    );
    open();
    await act(async () => {
      fireEvent.click(generate());
    });
    expect(screen.getByRole('alert')).toHaveTextContent('did not return a usable icon');
    expect(keep().disabled).toBe(true);
    expect((generate() as HTMLButtonElement).disabled).toBe(false);
  });

  it('will not draw from an empty description', () => {
    open();
    fireEvent.change(brief(), { target: { value: '   ' } });
    expect((generate() as HTMLButtonElement).disabled).toBe(true);
  });
});
