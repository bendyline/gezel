import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({ listConnectorTypes: vi.fn() }));
vi.mock('../api.js', () => ({ api: apiMocks }));
const nav = vi.hoisted(() => ({
  runNavActions: vi.fn(),
  openProjectFileActions: vi.fn((intent: unknown) => [intent]),
}));
vi.mock('./nav-actions.js', () => nav);

import { resetConnectorTypeArt } from './ConnectorMark.js';
import { MessageInclusions } from './MessageInclusions.js';

const SAVED = {
  connectorType: 'website',
  subject: 'https://gezel.com/platform',
  label: 'gezel.com/platform',
  title: 'The Gezel platform',
  path: 'data/saved-pages/gezel-com/001--platform--1a2b3c4d.md',
  summary: 'Gezel runs on your own computer.',
};

describe('MessageInclusions', () => {
  beforeEach(() => {
    resetConnectorTypeArt();
    nav.runNavActions.mockClear();
    apiMocks.listConnectorTypes.mockReset();
    apiMocks.listConnectorTypes.mockResolvedValue({
      items: [
        {
          manifest: { id: 'website', name: 'Websites', tags: ['web', 'pages'] },
          logoUrl: 'data:image/webp;base64,AAAA',
        },
      ],
    });
  });

  it('links a message to the saved copy of the page it named, with its synopsis and mark', async () => {
    const user = userEvent.setup();
    const { container } = render(<MessageInclusions inclusions={[SAVED]} projectId="p1" />);
    expect(screen.getByText('The Gezel platform')).toBeInTheDocument();
    expect(screen.getByText('Saved copy of gezel.com/platform')).toBeInTheDocument();
    expect(screen.getByText('Gezel runs on your own computer.')).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(container.querySelector('.msg-inclusion-mark img')).toHaveAttribute(
        'data-ground',
        'teal',
      ),
    );
    await user.click(screen.getByRole('button', { name: /The Gezel platform/ }));
    expect(nav.openProjectFileActions).toHaveBeenCalledWith({
      projectId: 'p1',
      path: SAVED.path,
      source: 'artifacts',
    });
    expect(nav.runNavActions).toHaveBeenCalledTimes(1);
  });

  it('says why when nothing was saved', () => {
    render(
      <MessageInclusions
        inclusions={[
          {
            connectorType: 'website',
            subject: 'https://www.microsoft.com/',
            label: 'www.microsoft.com',
            reason: 'The site showed a bot check.',
          },
        ]}
        projectId="p1"
      />,
    );
    expect(screen.getByText('www.microsoft.com was not saved')).toBeInTheDocument();
    expect(screen.getByText('The site showed a bot check.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
