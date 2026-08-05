import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { ProjectOutputPane } from './ProjectOutputPane.js';
import { OUTPUT_PANE_MAXIMIZED_EVENT, OUTPUT_PANE_RESTORE_EVENT } from './output-pane-maximize.js';

vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const longPageLabel = 'evals/src/scenarios/fixtures/petshop-gemma4-e4b-q4-2026-07-10-malformed';

beforeEach(() => {
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverMock as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 320,
  });
  vi.mocked(api.getConfig).mockResolvedValue({
    provider: 'openai',
    hasGithubToken: false,
    hasOpenaiApiKey: false,
    hasBraveSearchApiKey: false,
    hasTavilyApiKey: false,
    hasWebhookBearerToken: false,
    hasWebhookBasicAuth: false,
  });
  vi.mocked(api.createProjectTypePreviewUrl).mockResolvedValue({
    url: 'http://127.0.0.1/preview/cap/type/project/report.html',
    expiresAt: '2026-07-29T12:00:00.000Z',
    scopePath: '',
  });
});

afterEach(() => {
  delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
});

describe('ProjectOutputPane responsive toolbar', () => {
  it('reports maximize state and accepts a restore request from the titlebar', async () => {
    const states: boolean[] = [];
    const onMaximized = (event: Event) => {
      states.push((event as CustomEvent<{ maximized: boolean }>).detail.maximized);
    };
    window.addEventListener(OUTPUT_PANE_MAXIMIZED_EVENT, onMaximized);
    const { container } = render(
      <ProjectOutputPane
        projectId="project"
        htmlFiles={[]}
        typePage={{ entry: 'report.html', label: longPageLabel }}
        onClose={() => {}}
      />,
    );

    fireEvent.keyDown(window, { key: 'F5' });
    await waitFor(() =>
      expect(container.querySelector('.project-output-pane')).toHaveClass(
        'project-output-pane-maximized',
      ),
    );
    expect(states).toContain(true);

    window.dispatchEvent(new CustomEvent(OUTPUT_PANE_RESTORE_EVENT));
    await waitFor(() =>
      expect(container.querySelector('.project-output-pane')).not.toHaveClass(
        'project-output-pane-maximized',
      ),
    );
    expect(states.at(-1)).toBe(false);
    window.removeEventListener(OUTPUT_PANE_MAXIMIZED_EVENT, onMaximized);
  });

  it('collapses a long page label to an accessible page icon in a narrow pane', async () => {
    render(
      <ProjectOutputPane
        projectId="project"
        htmlFiles={[]}
        typePage={{ entry: 'report.html', label: longPageLabel }}
        onClose={() => {}}
      />,
    );

    const picker = screen.getByRole('combobox', {
      name: `Choose output page. Current page: ${longPageLabel}`,
    });
    await waitFor(() => expect(picker).toHaveClass('is-compact'));

    expect(picker).not.toHaveTextContent(longPageLabel);
    expect(picker.querySelector('.project-output-picker-icon')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More output actions' })).toBeInTheDocument();
  });

  it('renders the debug-frame action with a flat SVG camera icon', () => {
    render(
      <ProjectOutputPane
        projectId="project"
        htmlFiles={[]}
        typePage={{ entry: 'report.html', label: longPageLabel }}
        onClose={() => {}}
        onDebugFrame={() => {}}
      />,
    );

    const capture = screen.getByRole('button', { name: 'Send a debug frame to the chat' });
    expect(capture.querySelector('svg')).toBeInTheDocument();
    expect(capture).not.toHaveTextContent('📷');
  });
});
