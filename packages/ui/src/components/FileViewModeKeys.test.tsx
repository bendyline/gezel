import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FileHiddenKey } from './FileViewModeKeys.js';

describe('FileHiddenKey', () => {
  it('reports its state through aria-pressed and toggles both ways', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <FileHiddenKey kind="workspace" value={false} onChange={onChange} />,
    );

    const key = screen.getByRole('button', { name: 'Show hidden files' });
    expect(key).toHaveAttribute('aria-pressed', 'false');
    await user.click(key);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<FileHiddenKey kind="workspace" value={true} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Show hidden files' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Show hidden files' }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('names what each tab is hiding', () => {
    const { rerender } = render(
      <FileHiddenKey kind="workspace" value={false} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Show hidden files' })).toHaveAttribute(
      'title',
      'Show hidden files — dot-files and folders like node_modules.',
    );

    rerender(<FileHiddenKey kind="artifacts" value={false} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Show hidden files' })).toHaveAttribute(
      'title',
      'Show hidden files — dot-files and the generated shadow folder.',
    );
  });
});
