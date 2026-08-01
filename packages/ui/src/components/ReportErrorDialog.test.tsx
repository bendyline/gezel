import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { ReportErrorDialog } = await import('./ReportErrorDialog.js');
const { api } = await import('../api.js');

const SIGILL = '[llama-cpp] on-device engine crashed (SIGILL); incident=native-51832-1785547847453';

function openedUrl(): URL {
  const open = vi.mocked(window.open);
  expect(open).toHaveBeenCalled();
  return new URL(String(open.mock.calls[0]?.[0]));
}

/** The textarea, once the async diagnostics fetch has composed the body. */
async function findFilledTextarea(marker = '### Machine'): Promise<HTMLTextAreaElement> {
  const area = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
  await waitFor(() => expect(area.value).toContain(marker));
  return area;
}

/**
 * Install a clipboard spy. Must run AFTER `userEvent.setup()`, which
 * installs a clipboard stub of its own and would otherwise clobber this one.
 */
function stubClipboard(fail = false): ReturnType<typeof vi.fn> {
  const writeText = fail
    ? vi.fn().mockRejectedValue(new Error('denied'))
    : vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

beforeEach(() => {
  stubClipboard();
  vi.stubGlobal('open', vi.fn());
  window.__GEZEL__ = { ...window.__GEZEL__, platform: 'linux' } as typeof window.__GEZEL__;
});

describe('ReportErrorDialog', () => {
  it('fetches the machine profile once and fills the textarea', async () => {
    render(
      <ReportErrorDialog
        open
        report={{ surface: 'chat-turn', message: SIGILL }}
        onClose={() => {}}
      />,
    );

    const area = await findFilledTextarea();
    expect(area.value).toContain('on-device engine crashed');
    expect(area.value).toContain('AMD Radeon RX 7900 XTX');
    expect(api.getSystemDiagnostics).toHaveBeenCalledTimes(1);
  });

  it('does not reset what the user typed when the parent re-renders', async () => {
    // The streaming-bubble regression: `StreamingBubble` re-renders on every
    // token with a fresh `report` object literal. An effect keyed on that
    // identity would wipe the textarea mid-sentence.
    const user = userEvent.setup();
    const report = { surface: 'chat-turn' as const, message: SIGILL };
    const { rerender } = render(<ReportErrorDialog open report={report} onClose={() => {}} />);
    const area = await findFilledTextarea();

    await user.clear(area);
    await user.type(area, 'I was asking about bread');

    rerender(
      <ReportErrorDialog
        open
        report={{ surface: 'chat-turn', message: SIGILL }}
        onClose={() => {}}
      />,
    );

    expect(area).toHaveValue('I was asking about bread');
    expect(api.getSystemDiagnostics).toHaveBeenCalledTimes(1);
  });

  it('still produces a usable report when the diagnostics fetch fails', async () => {
    // The service being down is a very common thing to want to report.
    vi.mocked(api.getSystemDiagnostics).mockRejectedValueOnce(new Error('service unavailable'));
    render(
      <ReportErrorDialog
        open
        report={{ surface: 'chat-turn', message: SIGILL }}
        onClose={() => {}}
      />,
    );

    const area = await findFilledTextarea('Machine profile unavailable');
    expect(area.value).toContain('on-device engine crashed');
    expect(screen.getByRole('button', { name: /create issue/i })).toBeEnabled();
  });

  it('opens a GitHub issue carrying the edited text', async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    const onClose = vi.fn();
    render(
      <ReportErrorDialog
        open
        report={{
          surface: 'chat-turn',
          message: SIGILL,
          detail: { code: 'native-engine-crash', engine: 'llama-cpp', panicKind: 'SIGILL' },
        }}
        onClose={onClose}
      />,
    );
    const area = await findFilledTextarea();

    await user.clear(area);
    await user.type(area, 'I asked for a recipe and it died');
    await user.click(screen.getByRole('button', { name: /create issue/i }));

    const url = openedUrl();
    expect(url.origin + url.pathname).toBe('https://github.com/bendyline/gezel/issues/new');
    expect(url.searchParams.get('body')).toBe('I asked for a recipe and it died');
    expect(url.searchParams.get('labels')).toBe('bug');
    expect(url.searchParams.get('title')).toContain('[llama-cpp]');
    expect(writeText).toHaveBeenCalledWith('I asked for a recipe and it died');
    expect(vi.mocked(window.open).mock.calls[0]?.[2]).toBe('noopener,noreferrer');
    expect(onClose).toHaveBeenCalled();
  });

  it('warns about shortening only when the report exceeds the platform budget', async () => {
    window.__GEZEL__ = { ...window.__GEZEL__, platform: 'win32' } as typeof window.__GEZEL__;
    const { unmount } = render(
      <ReportErrorDialog
        open
        report={{ surface: 'tab-crash', message: 'boom', stack: 'at frame\n'.repeat(300) }}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(/longer than a link can carry/i)).toBeInTheDocument();
    unmount();

    render(
      <ReportErrorDialog
        open
        report={{ surface: 'chat-turn', message: 'boom' }}
        onClose={() => {}}
      />,
    );
    await screen.findByRole('textbox');
    expect(screen.queryByText(/longer than a link can carry/i)).not.toBeInTheDocument();
  });

  it('still opens the issue when the clipboard is denied', async () => {
    const user = userEvent.setup();
    stubClipboard(true);
    render(
      <ReportErrorDialog
        open
        report={{ surface: 'chat-turn', message: SIGILL }}
        onClose={() => {}}
      />,
    );
    await screen.findByRole('textbox');
    await user.click(screen.getByRole('button', { name: /create issue/i }));
    expect(window.open).toHaveBeenCalled();
  });

  it('cancels without opening anything', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ReportErrorDialog
        open
        report={{ surface: 'chat-turn', message: SIGILL }}
        onClose={onClose}
      />,
    );
    await screen.findByRole('textbox');
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });
});
