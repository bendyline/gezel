import {
  DESKTOP_RUNTIME_CAPABILITIES,
  PROJECT_ICON_IMAGE_MAX_BYTES,
  type ProjectDetail,
} from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
// Scaling a picture needs a canvas, which jsdom does not draw.
vi.mock('./project-icon-art.js', async (original) => ({
  ...(await original<typeof import('./project-icon-art.js')>()),
  prepareProjectIconImage: vi.fn(),
}));

const { ProjectIconField } = await import('./ProjectIconField.js');
const { prepareProjectIconImage } = await import('./project-icon-art.js');
const { api } = await import('../api.js');

const project = { id: 'orchard', name: 'Orchard', projectTypeId: 'web-app' } as ProjectDetail;
const bridge = window.__GEZEL__;

function host(capabilities: Partial<typeof DESKTOP_RUNTIME_CAPABILITIES>) {
  window.__GEZEL__ = {
    ...(bridge ?? {}),
    capabilities: { ...DESKTOP_RUNTIME_CAPABILITIES, ...capabilities },
  } as typeof window.__GEZEL__;
}

function pick(file: File) {
  const input = screen.getByLabelText('Icon picture') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe('ProjectIconField', () => {
  beforeEach(() => {
    vi.mocked(api.updateProject).mockReset();
    vi.mocked(api.uploadProjectIcon).mockReset();
    vi.mocked(prepareProjectIconImage).mockReset();
  });
  afterEach(() => {
    window.__GEZEL__ = bridge;
  });

  it('offers a drawing and an upload only where the host keeps icon art', () => {
    host({ projectIconArt: false });
    const { unmount } = render(<ProjectIconField project={project} onChanged={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Automatic' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draw one…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload a picture…' })).toBeNull();
    unmount();

    host({ projectIconArt: true });
    render(<ProjectIconField project={project} onChanged={() => {}} />);
    expect(screen.getByRole('button', { name: 'Draw one…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload a picture…' })).toBeInTheDocument();
  });

  it('opens the drawing with a description made from the project and its type', () => {
    host({ projectIconArt: true });
    render(<ProjectIconField project={project} typeLabel="Web app" onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Draw one…' }));
    const brief = screen.getByLabelText('What should it show?') as HTMLTextAreaElement;
    expect(brief.value).toContain('“Orchard”, a web app project');
    expect(brief.value).toContain('a pair of code braces');
  });

  it('scales an uploaded picture down, sends it, and hands back the saved project', async () => {
    host({ projectIconArt: true });
    const small = new Blob([new Uint8Array(1200)], { type: 'image/png' });
    vi.mocked(prepareProjectIconImage).mockResolvedValue(small);
    const saved = {
      ...project,
      customIcon: { kind: 'image', format: 'png', updatedAt: '2026-11-12T00:00:00Z' },
    } as ProjectDetail;
    vi.mocked(api.uploadProjectIcon).mockResolvedValue(saved);
    const onChanged = vi.fn();
    render(<ProjectIconField project={project} onChanged={onChanged} />);

    const photo = new File([new Uint8Array(4_000_000)], 'orchard.jpg', { type: 'image/jpeg' });
    await act(async () => {
      pick(photo);
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(saved));
    expect(prepareProjectIconImage).toHaveBeenCalledWith(photo);
    // The scaled picture is what travels, never the original.
    expect(api.uploadProjectIcon).toHaveBeenCalledWith('orchard', small);
  });

  it('refuses a file that is not a picture it can use, before reading it', async () => {
    host({ projectIconArt: true });
    render(<ProjectIconField project={project} onChanged={() => {}} />);
    await act(async () => {
      pick(new File(['GIF89a'], 'spin.gif', { type: 'image/gif' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('PNG, JPEG or WebP');
    expect(prepareProjectIconImage).not.toHaveBeenCalled();
    expect(api.uploadProjectIcon).not.toHaveBeenCalled();
  });

  it('refuses a picture that is still too large once scaled', async () => {
    host({ projectIconArt: true });
    vi.mocked(prepareProjectIconImage).mockResolvedValue(
      new Blob([new Uint8Array(PROJECT_ICON_IMAGE_MAX_BYTES + 1)], { type: 'image/png' }),
    );
    render(<ProjectIconField project={project} onChanged={() => {}} />);
    await act(async () => {
      pick(new File([new Uint8Array(10)], 'big.png', { type: 'image/png' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('too large');
    expect(api.uploadProjectIcon).not.toHaveBeenCalled();
  });

  it('saves a chosen mark at once', async () => {
    host({ projectIconArt: true });
    const saved = { ...project, icon: 'sprout' } as ProjectDetail;
    vi.mocked(api.updateProject).mockResolvedValue(saved);
    const onChanged = vi.fn();
    render(<ProjectIconField project={project} onChanged={onChanged} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Sprout' }));
    });
    expect(api.updateProject).toHaveBeenCalledWith('orchard', { icon: 'sprout' });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(saved));
  });
});
