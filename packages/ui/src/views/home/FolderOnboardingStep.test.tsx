import type { WellKnownFoldersResponse } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';

const FOLDERS: WellKnownFoldersResponse = {
  folders: [
    {
      kind: 'pictures',
      label: 'Pictures',
      path: '/Users/ada/Pictures',
      exists: true,
      cloud: 'icloud',
      census: {
        files: 12_600,
        images: 12_480,
        videos: 0,
        documents: 0,
        cloudOnly: 1204,
        complete: true,
      },
    },
    {
      kind: 'documents',
      label: 'Documents',
      path: '/Users/ada/Documents',
      exists: true,
      sharedLibrary: true,
      projectId: 'shared',
    },
    {
      kind: 'desktop',
      label: 'Desktop',
      path: '/Users/ada/Desktop',
      exists: true,
      census: { files: 12, images: 3, videos: 0, documents: 4, cloudOnly: 0, complete: true },
    },
    { kind: 'downloads', label: 'Downloads', path: '/Users/ada/Downloads', exists: true },
  ],
  codeFolders: [{ path: '/Users/ada/code/app', name: 'app' }],
};

vi.mock('../../api.js', () => ({
  api: createMockApi({
    listWellKnownFolders: vi.fn().mockResolvedValue(FOLDERS),
    inferProjectForPath: vi.fn().mockResolvedValue({ project: { id: 'pictures' } }),
    updateConfig: vi.fn().mockResolvedValue({}),
  }),
}));

const { FolderOnboardingStep, shouldOfferFolderStep } = await import('./FolderOnboardingStep.js');
const { api } = await import('../../api.js');

describe('FolderOnboardingStep', () => {
  it('offers Pictures preselected with what it holds, and leaves the library out', async () => {
    render(<FolderOnboardingStep config={null} onDone={() => {}} />);
    const pictures = await screen.findByRole('checkbox', { name: /Pictures/ });
    expect(pictures).toBeChecked();
    expect(screen.getByText('12,480 photos · 1,204 only in iCloud')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Desktop/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /app/ })).not.toBeChecked();
    expect(screen.queryByText('Documents')).toBeNull();
    expect(screen.queryByText('Downloads')).toBeNull();
  });

  it('adds the chosen folders with their crew and night work, then records the step', async () => {
    const onDone = vi.fn();
    render(<FolderOnboardingStep config={null} onDone={onDone} />);
    await screen.findByRole('checkbox', { name: /Pictures/ });
    fireEvent.click(screen.getByRole('radio', { name: 'Not now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add this folder' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(vi.mocked(api.inferProjectForPath)).toHaveBeenCalledWith({
      path: '/Users/ada/Pictures',
      kind: 'folder',
      source: 'first-run',
      create: true,
      recruitCrew: true,
      nightWork: false,
    });
    expect(vi.mocked(api.updateConfig)).toHaveBeenCalledWith({
      onboarding: {
        foldersStepDoneAt: expect.any(String),
        overnightStepDoneAt: expect.any(String),
      },
    });
  });
});

describe('shouldOfferFolderStep', () => {
  it('offers until done, and not once a folder is added', () => {
    expect(shouldOfferFolderStep({} as never, [])).toBe(true);
    expect(
      shouldOfferFolderStep({ onboarding: { foldersStepDoneAt: '2026-10-07' } } as never, []),
    ).toBe(false);
    expect(shouldOfferFolderStep({} as never, [{ workingDir: '/Users/ada/app' }])).toBe(false);
    expect(
      shouldOfferFolderStep({} as never, [
        { workingDir: '/Users/ada/Documents', properties: { 'gezel.sharedLibrary': '1' } },
      ]),
    ).toBe(true);
    expect(shouldOfferFolderStep(null, [])).toBe(false);
  });
});
