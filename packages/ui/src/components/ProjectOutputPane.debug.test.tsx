import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { ProjectOutputPane } from './ProjectOutputPane.js';

vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});

const failedResponse = {
  runId: 'run-126',
  status: 'error' as const,
  callsSummary: [{ kind: 'fs.read', durationMs: 3 }],
  error: 'script exited with code 126',
};

const failedRun = {
  id: 'run-126',
  projectId: 'checkers',
  scriptName: 'game-store',
  startedAt: '2026-07-19T10:00:00.000Z',
  finishedAt: '2026-07-19T10:00:00.050Z',
  status: 'error' as const,
  trigger: { kind: 'page' as const, tool: 'user_move' },
  inputs: { action: 'user_move', from: 'a3', to: 'b4' },
  calls: [],
  logs: 'the complete sandbox diagnostic',
  error: 'script exited with code 126',
};

const baseConfig = {
  provider: 'openai' as const,
  hasGithubToken: false,
  hasOpenaiApiKey: false,
  hasBraveSearchApiKey: false,
  hasTavilyApiKey: false,
  hasWebhookBearerToken: false,
  hasWebhookBasicAuth: false,
};

function renderPane() {
  return render(
    <ProjectOutputPane
      projectId="checkers"
      htmlFiles={[]}
      typePage={{ entry: 'board/index.html', label: 'Dashboard', pageTools: ['user_move'] }}
      onClose={() => {}}
    />,
  );
}

async function invokeFromPage() {
  const frame = screen.getByTitle('Dashboard') as HTMLIFrameElement;
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          __gezelPageInvoke: true,
          id: 'pi-1',
          tool: 'user_move',
          input: { from: 'a3', to: 'b4' },
        },
      }),
    );
  });
}

describe('ProjectOutputPane script error copy', () => {
  beforeEach(() => {
    vi.mocked(api.createProjectTypePreviewUrl).mockResolvedValue({
      url: 'http://127.0.0.1/preview/cap/type/checkers/board/index.html',
      expiresAt: '2026-07-19T12:00:00.000Z',
      scopePath: 'board',
    });
    vi.mocked(api.invokeProjectPageTool).mockResolvedValue(failedResponse);
    vi.mocked(api.getProjectScriptRun).mockResolvedValue(failedRun);
  });

  it('hydrates and copies the full failed run when debug mode is on', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ ...baseConfig, debugMode: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderPane();
    await waitFor(() => expect(api.getConfig).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    await invokeFromPage();

    const copy = await screen.findByRole('button', {
      name: 'Copy full script error details',
    });
    expect(api.getProjectScriptRun).toHaveBeenCalledWith('checkers', 'run-126');
    fireEvent.click(copy);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain('the complete sandbox diagnostic');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('does not hydrate or show diagnostics when debug mode is off', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ ...baseConfig, debugMode: false });

    renderPane();
    await waitFor(() => expect(api.getConfig).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    await invokeFromPage();
    await waitFor(() => expect(api.invokeProjectPageTool).toHaveBeenCalled());

    expect(api.getProjectScriptRun).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Copy full script error details' }),
    ).not.toBeInTheDocument();
  });
});
