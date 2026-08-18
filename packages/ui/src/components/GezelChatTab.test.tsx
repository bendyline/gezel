import type { GezelDetail, ProjectForGezel } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('./ChatComposer.js', () => ({ ChatComposer: () => null }));
vi.mock('./ChatReferences.js', () => ({ ChatReferences: () => null }));
vi.mock('./GezelTimeline.js', () => ({ GezelTimeline: () => null }));
vi.mock('./ProjectTimeline.js', () => ({ ProjectTimeline: () => null }));
vi.mock('./SessionSwitcher.js', () => ({ SessionSwitcher: () => null }));

const { GezelChatTab } = await import('./GezelChatTab.js');
const { api } = await import('../api.js');

const GEZEL = { id: 'g1', name: 'Maya', role: 'Researcher' } as GezelDetail;
const PROJECTS: ProjectForGezel[] = [
  { projectId: 'p1', projectName: 'Alpha', precedence: 'assignment' },
  { projectId: 'p2', projectName: 'Beta', precedence: 'session' },
];

describe('GezelChatTab project selection', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(api.listProjectsForGezel).mockResolvedValue({ projects: PROJECTS });
  });

  it('prefers a working project when the remembered project is idle', async () => {
    window.localStorage.setItem('gezel:chat:last-project:g1', 'p1');

    render(<GezelChatTab gezel={GEZEL} engineLabel={null} workingProjectIds={new Set(['p2'])} />);

    await waitFor(() => expect(screen.getByTestId('mock-select')).toHaveValue('p2'));
    await waitFor(() =>
      expect(window.localStorage.getItem('gezel:chat:last-project:g1')).toBe('p2'),
    );
  });

  it('waits for the initial activity snapshot before settling on the remembered project', async () => {
    window.localStorage.setItem('gezel:chat:last-project:g1', '__ALL__');
    const workingProjectIds = new Set(['p2']);
    const view = render(
      <GezelChatTab
        gezel={GEZEL}
        engineLabel={null}
        workingProjectIds={workingProjectIds}
        activeTurnsReady={false}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('mock-select')).toHaveValue('__ALL__'));

    view.rerender(
      <GezelChatTab
        gezel={GEZEL}
        engineLabel={null}
        workingProjectIds={workingProjectIds}
        activeTurnsReady
      />,
    );

    await waitFor(() => expect(screen.getByTestId('mock-select')).toHaveValue('p2'));
  });

  it('keeps the remembered project when that project is working', async () => {
    window.localStorage.setItem('gezel:chat:last-project:g1', 'p2');

    render(
      <GezelChatTab gezel={GEZEL} engineLabel={null} workingProjectIds={new Set(['p1', 'p2'])} />,
    );

    await waitFor(() => expect(screen.getByTestId('mock-select')).toHaveValue('p2'));
  });

  it('remembers a manual project choice for the next open', async () => {
    render(<GezelChatTab gezel={GEZEL} engineLabel={null} />);
    const select = await screen.findByTestId('mock-select');
    await waitFor(() => expect(select).toHaveValue('p1'));

    fireEvent.change(select, { target: { value: '__ALL__' } });
    await waitFor(() =>
      expect(window.localStorage.getItem('gezel:chat:last-project:g1')).toBe('__ALL__'),
    );
  });

  it('returns an already-open gezel to their working project when clicked again', async () => {
    render(<GezelChatTab gezel={GEZEL} engineLabel={null} workingProjectIds={new Set(['p2'])} />);
    const select = await screen.findByTestId('mock-select');
    await waitFor(() => expect(select).toHaveValue('p2'));
    fireEvent.change(select, { target: { value: '__ALL__' } });
    expect(select).toHaveValue('__ALL__');

    fireEvent(
      window,
      new CustomEvent('gezel:prefer-working-project', { detail: { gezelId: 'g1' } }),
    );

    await waitFor(() => expect(select).toHaveValue('p2'));
  });
});
