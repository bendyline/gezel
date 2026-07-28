import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from './test-utils/mockApi.js';

vi.mock('./api.js', () => ({
  api: createMockApi({
    allEventsUrl: vi.fn(() => 'http://127.0.0.1:0/api/chat/events'),
    authHeader: vi.fn(() => ({ Authorization: 'Bearer test-token' })),
    getFetch: vi.fn(() => fetch),
  }),
}));
vi.mock('./components/BoekwachterPill.js', () => ({ BoekwachterPill: () => null }));
vi.mock('./components/ClaudeCliPoolPill.js', () => ({ ClaudeCliPoolPill: () => null }));
vi.mock('./components/EngineStatusPill.js', () => ({ EngineStatusPill: () => null }));
vi.mock('./components/GrantConsentDialog.js', () => ({ GrantConsentDialog: () => null }));
vi.mock('./components/ModelBundleControls.js', () => ({
  ModelBundleImportController: () => null,
}));
vi.mock('./components/NeedsInputPanel.js', () => ({ NeedsInputPanel: () => null }));
vi.mock('./components/QueueMeter.js', () => ({ QueueMeter: () => null }));
vi.mock('./components/Sidebar.js', () => ({ Sidebar: () => null }));
vi.mock('./components/TabContent.js', () => ({
  TabContent: ({ tab }: { tab: { kind: string; id?: string } }) => (
    <div>{`${tab.kind}:${tab.id ?? ''}`}</div>
  ),
}));
vi.mock('./components/TabErrorBoundary.js', () => ({
  TabErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/TitlebarSearch.js', () => ({ TitlebarSearch: () => null }));
vi.mock('./embedded/EmbeddedChat.js', () => ({ EmbeddedChat: () => null }));
vi.mock('./settings-nav.js', () => ({ requestSettingsSection: vi.fn() }));
vi.mock('./shared-chat-events.js', () => ({
  streamSharedAllChatEvents: async function* () {},
}));
vi.mock('./sidebar-side.js', () => ({ syncSidebarSideFromConfig: vi.fn() }));
vi.mock('./theme.js', () => ({ syncThemeFromConfig: vi.fn() }));
vi.mock('./views/HomeView.js', () => ({ HomeView: () => <div>Home view</div> }));

const { App } = await import('./App.js');

describe('App project deletion navigation', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns to Home when the selected project is deleted', async () => {
    window.localStorage.setItem(
      'gezel:nav:selection',
      JSON.stringify({ kind: 'project', id: 'p1', at: 0, order: 0 }),
    );
    render(<App />);
    expect(screen.getByText('project:p1')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('gezel:project-deleted', { detail: { projectId: 'p1' } }),
      );
    });

    expect(await screen.findByText('Home view')).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem('gezel:nav:selection')).toBeNull());
  });
});
