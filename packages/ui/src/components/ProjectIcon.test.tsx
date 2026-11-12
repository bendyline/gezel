import type { Project } from '@bendyline/gezel';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { ProjectIcon } = await import('./ProjectIcon.js');
const { resetProjectIconArtCache } = await import('./project-icon-art.js');
const { api } = await import('../api.js');

const MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 20c0-8 6-14 16-16"/></svg>';

describe('ProjectIcon', () => {
  beforeEach(() => {
    resetProjectIconArtCache();
    vi.mocked(api.getProjectIcon).mockReset();
  });

  it('renders the applied type mark by default', () => {
    render(
      <ProjectIcon
        project={
          {
            id: 'api',
            name: 'API',
            projectType: {
              id: 'custom-api',
              version: '1.0.0',
              source: 'bundled',
              icon: 'server',
              appliedAt: '2026-08-16T00:00:00.000Z',
            },
          } as Project
        }
      />,
    );

    expect(document.querySelector('[data-project-icon="server"]')).toBeInTheDocument();
    expect(document.querySelector('[data-project-glyph="server"]')).toBeInTheDocument();
    expect(api.getProjectIcon).not.toHaveBeenCalled();
  });

  it('lets an instance override its inherited mark', () => {
    render(
      <ProjectIcon
        project={
          {
            id: 'notes',
            name: 'Notes',
            icon: 'heart',
            projectTypeId: 'content-writing',
          } as Project
        }
      />,
    );

    expect(document.querySelector('[data-project-icon="heart"]')).toBeInTheDocument();
  });

  it('paints a drawn mark as a mask in the current ink, never as markup', async () => {
    vi.mocked(api.getProjectIcon).mockResolvedValue(new Blob([MARK], { type: 'image/svg+xml' }));
    const project = {
      id: 'orchard',
      name: 'Orchard',
      icon: 'heart',
      customIcon: { kind: 'drawn', format: 'svg', updatedAt: '2026-11-12T00:00:00Z' },
    } as Project;
    const { rerender } = render(<ProjectIcon project={project} size={18} />);
    // The mark stands in until the art has loaded.
    expect(document.querySelector('[data-project-glyph="heart"]')).toBeInTheDocument();

    await waitFor(() => expect(document.querySelector('.project-icon-drawn')).not.toBeNull());
    const drawn = document.querySelector<HTMLElement>('.project-icon-drawn');
    expect(drawn?.style.maskImage).toContain('data:image/svg+xml');
    expect(drawn?.style.width).toBe('18px');
    expect(document.querySelector('svg')).toBeNull();
    expect(document.querySelector('[data-project-icon="drawn"]')).toBeInTheDocument();

    // Every place that shows the icon shares the one fetch.
    rerender(
      <>
        <ProjectIcon project={project} />
        <ProjectIcon project={project} size={24} />
      </>,
    );
    await waitFor(() => expect(document.querySelectorAll('.project-icon-drawn')).toHaveLength(2));
    expect(api.getProjectIcon).toHaveBeenCalledTimes(1);
  });

  it('shows an uploaded picture as it is, and fetches again when it changes', async () => {
    vi.mocked(api.getProjectIcon).mockResolvedValue(
      new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
    );
    const project = {
      id: 'photo',
      name: 'Photo',
      customIcon: { kind: 'image', format: 'png', updatedAt: '2026-11-12T00:00:00Z' },
    } as Project;
    const { rerender } = render(<ProjectIcon project={project} size={24} />);
    await waitFor(() => expect(document.querySelector('img.project-icon-image')).not.toBeNull());
    const image = document.querySelector<HTMLImageElement>('img.project-icon-image');
    expect(image?.src).toMatch(/^data:image\/png/);
    expect(image?.width).toBe(24);

    rerender(
      <ProjectIcon
        project={{
          ...project,
          customIcon: { kind: 'image', format: 'png', updatedAt: '2026-11-12T09:00:00Z' },
        }}
      />,
    );
    await waitFor(() => expect(api.getProjectIcon).toHaveBeenCalledTimes(2));
  });

  it('falls back to the mark when the art cannot be read', async () => {
    vi.mocked(api.getProjectIcon).mockRejectedValue(new Error('gone'));
    render(
      <ProjectIcon
        project={
          {
            id: 'lost',
            name: 'Lost',
            icon: 'coin',
            customIcon: { kind: 'image', format: 'png', updatedAt: '2026-11-12T00:00:00Z' },
          } as Project
        }
      />,
    );
    await waitFor(() => expect(api.getProjectIcon).toHaveBeenCalled());
    expect(document.querySelector('[data-project-glyph="coin"]')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});
