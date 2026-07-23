import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

vi.mock('@bendyline/gezel-client', () => ({
  streamAllChatEvents: vi.fn(async function* () {
    yield {
      event: {
        type: 'index_progress',
        phase: 'scan',
        projectId: 'default',
        detail: '3 files in 0s',
      },
    };
  }),
}));

const { BoekwachterPill } = await import('./BoekwachterPill.js');

describe('BoekwachterPill', () => {
  it('keeps full progress detail while exposing a compact titlebar label', async () => {
    const { container } = render(<BoekwachterPill />);

    const status = await screen.findByRole('status', {
      name: 'Boekwachter: scanning default — 3 files in 0s',
    });

    expect(status).toHaveAttribute(
      'title',
      'Background indexing (boekwachter): scanning default — 3 files in 0s',
    );
    expect(container.querySelector('.boekwachter-pill-label-full')).toHaveTextContent(
      'Boekwachter: scanning default — 3 files in 0s',
    );
    expect(container.querySelector('.boekwachter-pill-label-short')).toHaveTextContent('Indexing');
  });
});
