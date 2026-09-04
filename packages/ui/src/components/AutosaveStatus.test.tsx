// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AutosaveStatus } from './AutosaveStatus.js';

const autosave = (phase: string) =>
  ({ phase, error: new Error('disk full'), retry: vi.fn() }) as never;

describe('AutosaveStatus', () => {
  it('narrates the save by default', () => {
    render(<AutosaveStatus autosave={autosave('saved')} />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('says nothing about a save that worked when asked for failures only', () => {
    const { rerender } = render(<AutosaveStatus autosave={autosave('saved')} failuresOnly />);
    // A draft is a debounce and a local write away. Announcing that is noise
    // beside the message being written.
    expect(screen.queryByText('Saved')).toBeNull();
    rerender(<AutosaveStatus autosave={autosave('saving')} failuresOnly />);
    expect(screen.queryByText('Saving…')).toBeNull();
    rerender(<AutosaveStatus autosave={autosave('dirty')} failuresOnly />);
    expect(screen.queryByTitle('Unsaved changes')).toBeNull();
  });

  it('still speaks up when the words are somewhere they can be lost', () => {
    render(<AutosaveStatus autosave={autosave('error')} failuresOnly />);
    expect(screen.getByText('Save failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
