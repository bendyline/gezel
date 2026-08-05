import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';
import { primitivesMock } from '../../test-utils/primitivesMock.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../../primitives/index.js', () => primitivesMock);
vi.mock('./NewProjectDetailPane.js', () => ({ NewProjectPaneHero: () => null }));

const { NewProjectDialog } = await import('./NewProjectDialog.js');
const { api } = await import('../../api.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const repos = [
  {
    name: 'first',
    fullName: 'octocat/first',
    url: 'https://github.com/octocat/first',
    private: false,
  },
  {
    name: 'second',
    fullName: 'octocat/second',
    url: 'https://github.com/octocat/second',
    private: false,
  },
];

async function openGitHubPicker(): Promise<HTMLInputElement> {
  render(
    <NewProjectDialog open mode="crew" onClose={() => undefined} onCreated={() => undefined} />,
  );
  fireEvent.click(screen.getByRole('radio', { name: 'GitHub' }));
  await waitFor(() => expect(api.listGitHubRepos).toHaveBeenCalled());
  return screen.getByRole('textbox', { name: /GitHub repository/i }) as HTMLInputElement;
}

async function pickRepo(input: HTMLInputElement, fullName: string): Promise<void> {
  fireEvent.focus(input);
  const option = await screen.findByRole('button', { name: new RegExp(fullName) });
  fireEvent.mouseDown(option);
}

describe('NewProjectDialog GitHub repository drafting', () => {
  beforeEach(() => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [] } as never);
    vi.mocked(api.getGitHubIdentity).mockResolvedValue({
      signedIn: true,
      login: 'bendymike',
    } as never);
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      klerkGezelId: 'klerk-1',
      showPoppetjes: true,
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'klerk-1', name: 'Lukas', role: 'Klerk' }],
    } as never);
    vi.mocked(api.listGitHubRepos).mockResolvedValue({ repos } as never);
    vi.mocked(api.previewGitHubRepo).mockImplementation(async (url) => {
      const repo = url.endsWith('/second') ? 'second' : 'first';
      return {
        owner: 'octocat',
        repo,
        canonicalUrl: url,
        readme: `# ${repo}`,
        readmeTruncated: false,
      } as never;
    });
  });

  it('keeps the picker enabled and ignores the old draft when another repo is selected', async () => {
    const firstDraft = deferred<{ about: string; missionObjectives: string }>();
    vi.mocked(api.previewProjectAbout).mockImplementation(async (body) => {
      if (body.name === 'first') return firstDraft.promise;
      return {
        about: 'Second repository about text that is long enough for the project form.',
        missionObjectives:
          'Ship the second repository objectives without applying stale text from the first.',
      };
    });

    const input = await openGitHubPicker();
    await pickRepo(input, 'octocat/first');
    await screen.findByText('Lukas is drafting About and Mission objectives…');
    expect(input).toBeEnabled();

    await pickRepo(input, 'octocat/second');
    await waitFor(() => expect(api.previewProjectAbout).toHaveBeenCalledTimes(2));
    const firstSignal = vi.mocked(api.previewProjectAbout).mock.calls[0]?.[1];
    expect(firstSignal?.aborted).toBe(true);

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('second');
      expect(screen.getByRole('textbox', { name: /^About/ })).toHaveValue(
        'Second repository about text that is long enough for the project form.',
      );
    });

    await act(async () => {
      firstDraft.resolve({
        about: 'Stale first repository about text that must never reach the form.',
        missionObjectives: 'Stale first repository mission that must never reach the form.',
      });
      await firstDraft.promise;
    });
    expect(screen.getByRole('textbox', { name: /^About/ })).toHaveValue(
      'Second repository about text that is long enough for the project form.',
    );
  });

  it('shows the working Klerk and lets the user cancel the draft', async () => {
    const draft = deferred<{ about: string; missionObjectives: string }>();
    vi.mocked(api.previewProjectAbout).mockReturnValue(draft.promise);

    const input = await openGitHubPicker();
    await pickRepo(input, 'octocat/first');

    await screen.findByText('Lukas is drafting About and Mission objectives…');
    expect(screen.getByTitle('Lukas is working')).toHaveClass('gezel-icon--pulse');
    const signal = vi.mocked(api.previewProjectAbout).mock.calls[0]?.[1];

    fireEvent.click(screen.getByRole('button', { name: 'Cancel draft' }));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(input).toBeEnabled();

    await act(async () => {
      draft.resolve({
        about: 'Cancelled text that must not reach the form even if the provider returns it.',
        missionObjectives: 'Cancelled objectives that must not reach the form after cancellation.',
      });
      await draft.promise;
    });
    expect(screen.getByRole('textbox', { name: /^About/ })).toHaveValue('');
  });
});
