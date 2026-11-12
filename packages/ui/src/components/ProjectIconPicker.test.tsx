import { type Project, ProjectIconIdSchema } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { PROJECT_ICON_LABELS, ProjectIconPicker } = await import('./ProjectIconPicker.js');

const codeFolder = { id: 'squisq', name: 'squisq', projectTypeId: 'web-app' } as Project;
const checked = (name: string) =>
  screen.getByRole('radio', { name }).getAttribute('aria-checked') === 'true';

describe('ProjectIconPicker', () => {
  it('names every mark, so an icon-only key is never unlabeled', () => {
    for (const id of ProjectIconIdSchema.options) expect(PROJECT_ICON_LABELS[id]).toBeTruthy();
    expect(new Set(Object.values(PROJECT_ICON_LABELS)).size).toBe(
      ProjectIconIdSchema.options.length,
    );
  });

  it('starts on Automatic, showing the mark the type gives the project', () => {
    render(<ProjectIconPicker project={codeFolder} onChange={() => {}} />);
    expect(checked('Automatic')).toBe(true);
    expect(
      screen.getByRole('radio', { name: 'Automatic' }).querySelector('[data-project-glyph="code"]'),
    ).not.toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(ProjectIconIdSchema.options.length + 1);
  });

  it('saves a chosen mark, and Automatic clears it', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ProjectIconPicker project={codeFolder} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Palette' }));
    expect(onChange).toHaveBeenLastCalledWith('palette');

    rerender(
      <ProjectIconPicker project={{ ...codeFolder, icon: 'palette' }} onChange={onChange} />,
    );
    expect(checked('Palette')).toBe(true);
    expect(checked('Automatic')).toBe(false);
    // Automatic still shows the type's mark, not the chosen one.
    expect(
      screen.getByRole('radio', { name: 'Automatic' }).querySelector('[data-project-glyph="code"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Automatic' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('shows art of the project’s own as the key that is down', () => {
    const onChange = vi.fn();
    render(
      <ProjectIconPicker
        project={{
          ...codeFolder,
          // A mark chosen earlier stays on the record; the art is what shows.
          icon: 'palette',
          customIcon: { kind: 'drawn', format: 'svg', updatedAt: '2026-11-12T00:00:00Z' },
        }}
        onChange={onChange}
      />,
    );
    expect(checked('Its own')).toBe(true);
    expect(checked('Palette')).toBe(false);
    expect(checked('Automatic')).toBe(false);
    // Any mark, or Automatic, is one press away and puts the art away.
    fireEvent.click(screen.getByRole('radio', { name: 'Palette' }));
    expect(onChange).toHaveBeenLastCalledWith('palette');
    fireEvent.click(screen.getByRole('radio', { name: 'Automatic' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('offers a drawing and an upload only to a host that passes them', () => {
    const { rerender } = render(<ProjectIconPicker project={codeFolder} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Draw one…' })).toBeNull();
    expect(screen.queryByLabelText('Icon picture')).toBeNull();

    const onDraw = vi.fn();
    const onUpload = vi.fn();
    rerender(
      <ProjectIconPicker
        project={codeFolder}
        onChange={() => {}}
        onDraw={onDraw}
        onUpload={onUpload}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Draw one…' }));
    expect(onDraw).toHaveBeenCalledTimes(1);

    const input = screen.getByLabelText('Icon picture') as HTMLInputElement;
    expect(input.accept).toBe('image/png,image/jpeg,image/webp');
    const file = new File([new Uint8Array(8)], 'mark.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onUpload).toHaveBeenCalledWith(file);
  });
});
