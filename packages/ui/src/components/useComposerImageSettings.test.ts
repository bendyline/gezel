import type { InstalledImageModel } from '@bendyline/gezel';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import type { PromptDraftController } from './usePromptDraft.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
const { api } = await import('../api.js');
const { useComposerImageSettings } = await import('./useComposerImageSettings.js');

const model = (id: string, extra: Partial<InstalledImageModel> = {}): InstalledImageModel => ({
  id,
  name: id,
  approxSizeBytes: 1,
  installedAt: '2026-10-27T00:00:00Z',
  kind: 'local',
  ...extra,
});

const draft = { draftId: null, meta: null } as unknown as PromptDraftController;

function settingsFor(edits: boolean) {
  vi.mocked(api.listInstalledImageModels).mockResolvedValue({
    models: [
      model('sdxl-base-1.0', { editMode: 'img2img' }),
      model('krea-2-turbo-q4'),
      model('qwen-image-edit-2511-q4', { editMode: 'reference', editOnly: true }),
    ],
    defaultModel: 'krea-2-turbo-q4',
    defaultEditModel: 'qwen-image-edit-2511-q4',
  });
  vi.mocked(api.getImageModelFit).mockResolvedValue({ models: [] } as never);
  return renderHook(() =>
    useComposerImageSettings({ enabled: true, draft, defaults: undefined, text: '', edits }),
  );
}

describe('useComposerImageSettings', () => {
  it('offers a generator the models that draw, starting from the default', async () => {
    const { result } = settingsFor(false);
    await waitFor(() => expect(result.current.model?.id).toBe('krea-2-turbo-q4'));
    expect(result.current.models.map((m) => m.id)).toEqual(['sdxl-base-1.0', 'krea-2-turbo-q4']);
  });

  it('offers an editor the models that edit, starting from the one an edit uses', async () => {
    const { result } = settingsFor(true);
    await waitFor(() => expect(result.current.model?.id).toBe('qwen-image-edit-2511-q4'));
    expect(result.current.models.map((m) => m.id)).toEqual([
      'sdxl-base-1.0',
      'qwen-image-edit-2511-q4',
    ]);
  });
});
