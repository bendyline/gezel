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

  it('names the count in words for screen readers and on hover', () => {
    render(<WorkChunksCount count={4} />);
    const badge = screen.getByRole('img', { name: /sent 4 chunks of work/ });
    expect(badge.getAttribute('title')).toBe(badge.getAttribute('aria-label'));
  });

  it('uses the singular for one chunk', () => {
    render(<WorkChunksCount count={1} />);
    expect(screen.getByRole('img', { name: /sent 1 chunk of work/ })).toBeTruthy();
  });
});
