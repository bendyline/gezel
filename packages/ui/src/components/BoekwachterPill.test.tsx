import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({
  api: createMockApi({
    getGezel: vi.fn().mockResolvedValue({
      id: 'noor',
      name: 'Noor',
      role: 'Boekwachter',
      updatedAt: '2026-07-30T00:00:00.000Z',
    }),
  }),
}));

vi.mock('@bendyline/gezel-client', () => ({
  streamAllChatEvents: vi.fn(async function* () {
    yield {
      event: {
        type: 'index_progress',
        phase: 'scan',
        state: 'ended',
        projectId: 'default',
        detail: '3 files in 0s',
        gezelId: 'noor',
        gezelName: 'Noor',
      },
    };
  }),
}));

const { BoekwachterPill } = await import('./BoekwachterPill.js');

describe('BoekwachterPill', () => {
  it('keeps full progress detail while exposing a compact titlebar label', async () => {
    const { container } = render(<BoekwachterPill />);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Noor: scanning default — 3 files in 0s');

    const button = screen.getByRole('button', {
      name: 'Open Noor — scanning default — 3 files in 0s',
    });
    expect(button).toHaveAttribute(
      'title',
      'Noor is scanning default — 3 files in 0s. Open gezel.',
    );
    expect(container.querySelector('.boekwachter-pill-label-full')).toHaveTextContent(
      'Noor: scanning default — 3 files in 0s',
    );
    expect(container.querySelector('.boekwachter-pill-label-short')).toHaveTextContent('Indexing');

    const open = vi.fn();
    window.addEventListener('gezel:open-tab', open);
    fireEvent.click(button);
    expect(open).toHaveBeenCalled();
    window.removeEventListener('gezel:open-tab', open);
  });
});
