import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { AppleFoundationModelsStatus } from './AppleFoundationModelsStatus.js';

vi.mock('../api.js', () => ({ api: { appleFoundationModelsStatus: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('shows actual readiness and can recheck after the OS model becomes available', async () => {
  vi.mocked(api.appleFoundationModelsStatus)
    .mockResolvedValueOnce({
      supported: true,
      installed: true,
      available: false,
      reason: 'The model is preparing.',
    })
    .mockResolvedValueOnce({
      supported: true,
      installed: true,
      available: true,
      runtime: {
        version: '2',
        os: '27',
        available: true,
        contextTokens: 8192,
        maxOutputTokens: 1024,
      },
    });
  render(<AppleFoundationModelsStatus />);
  expect(await screen.findByText('The model is preparing.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('8,192'));
  expect(api.appleFoundationModelsStatus).toHaveBeenCalledTimes(2);
});
