import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

const { StreamingBubble } = await import('./chat-bubbles.js');

const SIGILL =
  '[llama-cpp] on-device engine crashed (SIGILL); incident=native-51832-1785547847453. ' +
  'It will restart on the next request.';

beforeEach(() => {
  vi.stubGlobal('open', vi.fn());
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('the failed-turn banner', () => {
  it('files an issue carrying the engine, the crash class, and the machine profile', async () => {
    const user = userEvent.setup();
    render(
      <StreamingBubble
        authorLabel="Ada"
        authorIcon={null}
        segments={[]}
        startedAt={null}
        error={SIGILL}
        errorDetail={{
          code: 'native-engine-crash',
          engine: 'llama-cpp',
          incidentId: 'native-51832-1785547847453',
          panicKind: 'SIGILL',
        }}
      />,
    );

    // The original copy is untouched — the link joins it, it does not
    // replace it.
    expect(screen.getByText(/Turn stopped before finishing/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /report error on github/i }));
    const area = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toContain('### Machine'));
    await user.click(screen.getByRole('button', { name: /create issue/i }));

    const url = new URL(String(vi.mocked(window.open).mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe('https://github.com/bendyline/gezel/issues/new');
    expect(url.searchParams.get('title')).toBe(
      '[llama-cpp] on-device engine crashed (SIGILL); incident=native-N-N. It…',
    );
    const body = url.searchParams.get('body') ?? '';
    expect(body).toContain('code: native-engine-crash');
    expect(body).toContain('engine: llama-cpp');
    expect(body).toContain('panic: SIGILL');
    expect(body).toContain('AMD Radeon RX 7900 XTX');
    expect(body).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\Users\\/);
  });

  it('offers no report link on a healthy turn', () => {
    render(<StreamingBubble authorLabel="Ada" authorIcon={null} segments={[]} startedAt={null} />);
    expect(screen.queryByRole('button', { name: /report error on github/i })).toBeNull();
  });
});
