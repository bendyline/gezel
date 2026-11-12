import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './chat-bubbles.js';

const apiMocks = vi.hoisted(() => ({
  fetchProjectArtifactBlob: vi.fn(),
}));

vi.mock('../api.js', () => ({ api: apiMocks }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

describe('a relayed reply with pictures', () => {
  beforeEach(() => {
    apiMocks.fetchProjectArtifactBlob.mockReset();
    apiMocks.fetchProjectArtifactBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:relayed'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('shows the pictures in the handoff bubble, read from the project that holds them', async () => {
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        content="[Message from Bayu]: The rainbow is done."
        authorLabel="Cassian"
        authorIcon={null}
        projectId="default"
        from={{ gezelId: 'bayu', gezelName: 'Bayu' }}
        relayedImages={{
          projectId: 'winter-towns',
          images: [{ path: 'generated/image-7.png', mimeType: 'image/png' }],
        }}
      />,
    );

    expect(container.querySelector('.msg-from-gezel .msg-relayed-media')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open screenshot 1' })).toHaveAttribute(
      'title',
      'generated/image-7.png',
    );
    await waitFor(() =>
      expect(apiMocks.fetchProjectArtifactBlob).toHaveBeenCalledWith(
        'winter-towns',
        'generated/image-7.png',
      ),
    );
  });

  it('shows no media strip for a reply without pictures', () => {
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        content="[Message from Bayu]: Done."
        authorLabel="Cassian"
        authorIcon={null}
        from={{ gezelId: 'bayu', gezelName: 'Bayu' }}
      />,
    );
    expect(container.querySelector('.msg-relayed-media')).toBeNull();
  });
});
