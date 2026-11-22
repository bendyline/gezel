import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* () {},
}));

const { ProjectLookoutsSection } = await import('./ProjectLookoutsSection.js');
const { api } = await import('../../api.js');

const binding = (overrides: Record<string, unknown>) => ({
  id: 'b1',
  type: 'website',
  driver: 'native',
  displayName: 'Supplier prices',
  ...overrides,
});

describe('ProjectLookoutsSection', () => {
  afterEach(() => {
    vi.mocked(api.listConnectors).mockReset();
    vi.mocked(api.listConnectors).mockResolvedValue({ bindings: [] } as never);
  });

  it('offers a lookout on a project that follows a site but has no camera', async () => {
    // What's New told people to add a website lookout here, but the button
    // only appeared for projects with a camera.
    vi.mocked(api.listConnectors).mockResolvedValue({ bindings: [binding({})] } as never);
    render(<ProjectLookoutsSection projectId="p1" />);
    expect(await screen.findByRole('button', { name: 'Add a lookout' })).toBeTruthy();
    expect(screen.getByText(/watch for on a site/)).toBeTruthy();
  });

  it('still offers one for a camera', async () => {
    vi.mocked(api.listConnectors).mockResolvedValue({
      bindings: [
        binding({ id: 'cam', type: 'camera-local', driver: 'device', displayName: 'Door' }),
      ],
    } as never);
    render(<ProjectLookoutsSection projectId="p1" />);
    expect(await screen.findByRole('button', { name: 'Add a lookout' })).toBeTruthy();
    expect(screen.getByText(/Tell a camera what to keep a lookout for/)).toBeTruthy();
  });

  it('shows nothing for a project with neither', async () => {
    vi.mocked(api.listConnectors).mockResolvedValue({ bindings: [] } as never);
    const { container } = render(<ProjectLookoutsSection projectId="p1" />);
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: 'Add a lookout' })).toBeNull();
    expect(container.textContent).toBe('');
  });
});
