import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkChunksCount } from './WorkChunksCount.js';

describe('WorkChunksCount', () => {
  it('shows the count as the hammer exponent, without parentheses', () => {
    const { container } = render(<WorkChunksCount count={4} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('sup')?.textContent).toBe('4');
    expect(container.textContent).toBe('4');
  });

  it('names the count in words for screen readers', () => {
    render(<WorkChunksCount count={104} />);
    expect(
      screen.getByRole('img', { name: 'The model has reported progress 104 times' }),
    ).toBeTruthy();
  });

  it('says once for a single report', () => {
    render(<WorkChunksCount count={1} />);
    expect(screen.getByRole('img', { name: 'The model has reported progress once' })).toBeTruthy();
  });
});
