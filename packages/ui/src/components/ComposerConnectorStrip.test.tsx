import type { PromptConnectorOffer } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  promptConnectorOffers: vi.fn(),
  acceptPromptConnectorOffer: vi.fn(),
  listConnectorTypes: vi.fn(),
}));
vi.mock('../api.js', () => ({ api: apiMocks }));

import { type ComposerConnectorHandle, ComposerConnectorStrip } from './ComposerConnectorStrip.js';
import { resetConnectorTypeArt } from './ConnectorMark.js';

const PAGE: PromptConnectorOffer = {
  rule: 'web-page',
  connectorType: 'website',
  effect: 'include',
  subject: 'https://gezel.com/platform',
  label: 'gezel.com/platform',
  typeName: 'Websites',
  typeTags: ['web', 'pages'],
};
const SAVED = {
  inclusion: {
    connectorType: 'website',
    subject: PAGE.subject,
    label: PAGE.label,
    title: 'The Gezel platform',
    path: 'data/saved-pages/gezel-com/001--platform--1a2b3c4d.md',
    summary: 'Gezel runs on your own computer.',
  },
};
const TEXT = 'Can you summarize https://gezel.com/platform?';

function mount(text = TEXT, extra: Partial<Parameters<typeof ComposerConnectorStrip>[0]> = {}) {
  const ref = createRef<ComposerConnectorHandle>();
  const view = render(<ComposerConnectorStrip ref={ref} projectId="p1" text={text} {...extra} />);
  return { ref, ...view };
}

describe('ComposerConnectorStrip', () => {
  beforeEach(() => {
    resetConnectorTypeArt();
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    apiMocks.promptConnectorOffers.mockResolvedValue({ offers: [PAGE] });
    apiMocks.acceptPromptConnectorOffer.mockResolvedValue(SAVED);
    apiMocks.listConnectorTypes.mockResolvedValue({ items: [] });
  });

  it('says what Send will do, without asking', async () => {
    mount();
    expect(await screen.findByText('gezel.com/platform')).toBeInTheDocument();
    expect(screen.getByText(/will be saved here and included in the chat/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save now' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Don’t save gezel.com/platform' }),
    ).toBeInTheDocument();
    // Showing the notice fetched nothing.
    expect(apiMocks.acceptPromptConnectorOffer).not.toHaveBeenCalled();
  });

  it('asks the daemon nothing for a draft that names nothing', async () => {
    const { container } = mount('What should we have for dinner?');
    await act(async () => {});
    expect(apiMocks.promptConnectorOffers).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('saves on Send what the person did not dismiss', async () => {
    const { ref } = mount();
    await screen.findByText('gezel.com/platform');
    await act(async () => {
      await ref.current?.beforeSend(TEXT);
    });
    expect(apiMocks.acceptPromptConnectorOffer).toHaveBeenCalledWith('p1', {
      rule: 'web-page',
      subject: 'https://gezel.com/platform',
    });
    expect(await screen.findByText('The Gezel platform')).toBeInTheDocument();
    expect(screen.getByText(/It will be included in the chat/)).toBeInTheDocument();
  });

  it('saves nothing on Send for an address the person dismissed', async () => {
    const user = userEvent.setup();
    const { ref, container } = mount();
    await user.click(await screen.findByRole('button', { name: 'Don’t save gezel.com/platform' }));
    expect(container).toBeEmptyDOMElement();
    await act(async () => {
      await ref.current?.beforeSend(TEXT);
    });
    expect(apiMocks.acceptPromptConnectorOffer).not.toHaveBeenCalled();
  });

  it('saves once when the person pressed Save now and then Send', async () => {
    const user = userEvent.setup();
    let finish: (value: typeof SAVED) => void = () => {};
    apiMocks.acceptPromptConnectorOffer.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { ref } = mount();
    await user.click(await screen.findByRole('button', { name: 'Save now' }));
    expect(await screen.findByText(/Saving/)).toBeInTheDocument();
    let sent = false;
    const sending = ref.current?.beforeSend(TEXT).then(() => {
      sent = true;
    });
    await act(async () => {});
    // Send waits for the save already under way.
    expect(sent).toBe(false);
    await act(async () => {
      finish(SAVED);
      await sending;
    });
    expect(sent).toBe(true);
    expect(apiMocks.acceptPromptConnectorOffer).toHaveBeenCalledTimes(1);
  });

  it('takes an address pasted and sent before the strip caught up', async () => {
    const { ref } = mount('');
    await act(async () => {
      await ref.current?.beforeSend(TEXT);
    });
    expect(apiMocks.promptConnectorOffers).toHaveBeenCalledWith('p1', TEXT);
    expect(apiMocks.acceptPromptConnectorOffer).toHaveBeenCalledTimes(1);
  });

  it('shows the reason Gezel gives when a save fails, and does not retry it on Send', async () => {
    apiMocks.acceptPromptConnectorOffer.mockRejectedValue(
      new GezelApiError(
        'Gezel API error 400 on POST /api/projects/p1/prompt-connectors/accept',
        400,
        {
          error: 'The site refused the visit.',
        },
      ),
    );
    const user = userEvent.setup();
    const { ref } = mount();
    await user.click(await screen.findByRole('button', { name: 'Save now' }));
    expect(await screen.findByText(/The site refused the visit\./)).toBeInTheDocument();
    expect(screen.queryByText(/Gezel API error/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await act(async () => {
      await ref.current?.beforeSend(TEXT);
    });
    expect(apiMocks.acceptPromptConnectorOffer).toHaveBeenCalledTimes(1);
  });

  it('never holds Send when the daemon cannot answer', async () => {
    apiMocks.promptConnectorOffers.mockRejectedValue(new Error('offline'));
    const { ref, container } = mount();
    await act(async () => {
      await ref.current?.beforeSend(TEXT);
    });
    expect(apiMocks.acceptPromptConnectorOffer).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a connection that needs setting up as an offer, and never takes it on Send', async () => {
    const repo: PromptConnectorOffer = {
      rule: 'github-repo',
      connectorType: 'github-issues',
      effect: 'connect',
      subject: 'https://github.com/bendyline/gezel',
      label: 'bendyline/gezel',
      typeName: 'GitHub Issues',
    };
    // The daemon's rules decide: here one claims the address for GitHub.
    apiMocks.promptConnectorOffers.mockResolvedValue({ offers: [repo] });
    const onConnect = vi.fn();
    const user = userEvent.setup();
    const { ref } = mount('Look at https://github.com/bendyline/gezel', { onConnect });
    expect(await screen.findByText(/can be connected with GitHub Issues/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect…' }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    await act(async () => {
      await ref.current?.beforeSend('Look at https://github.com/bendyline/gezel');
    });
    expect(apiMocks.acceptPromptConnectorOffer).not.toHaveBeenCalled();
  });

  it('draws the connector’s own mark from the offer', async () => {
    apiMocks.promptConnectorOffers.mockResolvedValue({
      offers: [{ ...PAGE, logoUrl: 'data:image/webp;base64,AAAA' }],
    });
    const { container } = mount();
    await screen.findByText('gezel.com/platform');
    await waitFor(() => {
      const img = container.querySelector('.chat-composer-connector-mark img');
      expect(img).toHaveAttribute('src', 'data:image/webp;base64,AAAA');
      expect(img).toHaveAttribute('data-ground', 'teal');
    });
  });
});
