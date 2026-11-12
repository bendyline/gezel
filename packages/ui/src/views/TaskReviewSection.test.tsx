import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { TaskReviewSection } from './TaskReviewSection.js';

describe('TaskReviewSection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads an unset setting as Automatic', () => {
    render(<TaskReviewSection value={undefined} onSaved={() => {}} setStatus={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Automatic' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('saves the choice to config.taskReview', async () => {
    const saved = { taskReview: 'off' } as never;
    const update = vi.spyOn(api, 'updateConfig').mockResolvedValue(saved);
    const onSaved = vi.fn();
    render(<TaskReviewSection value="auto" onSaved={onSaved} setStatus={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(update).toHaveBeenCalledWith({ taskReview: 'off' });
  });
});
