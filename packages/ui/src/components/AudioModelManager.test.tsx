import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { AudioModelManager } = await import('./AudioModelManager.js');
const { api } = await import('../api.js');

const BASE = {
  id: 'whisper-base.en',
  name: 'Whisper Base (English)',
  approxSizeBytes: 147_900_000,
  installedAt: '2026-06-24T00:00:00.000Z',
};
const SMALL = {
  id: 'whisper-small.en',
  name: 'Whisper Small (English)',
  approxSizeBytes: 487_700_000,
  installedAt: '2026-06-25T00:00:00.000Z',
};

describe('AudioModelManager active-model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listAudioCatalog).mockResolvedValue({ stt: [], tts: [] } as never);
    vi.mocked(api.listInstalledSttModels).mockResolvedValue({ models: [BASE, SMALL] } as never);
  });

  it('omits the Active column when no onSetActiveModel handler is given', async () => {
    render(<AudioModelManager kind="stt" />);

    await screen.findByText('whisper-base.en');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Active' })).toBeNull();
  });

  it('marks the configured default active and persists a new pick', async () => {
    const onSet = vi.fn();
    render(
      <AudioModelManager
        kind="stt"
        configuredDefaultModelId="whisper-small.en"
        onSetActiveModel={onSet}
      />,
    );

    const small = await screen.findByRole('radio', {
      name: 'Use whisper-small.en as the active speech-to-text model',
    });
    const base = screen.getByRole('radio', {
      name: 'Use whisper-base.en as the active speech-to-text model',
    });
    expect(small).toBeChecked();
    expect(base).not.toBeChecked();

    await userEvent.click(base);
    expect(onSet).toHaveBeenCalledWith('whisper-base.en');
  });

  it('falls back to the first installed model when the configured default is gone', async () => {
    render(
      <AudioModelManager
        kind="stt"
        configuredDefaultModelId="whisper-tiny.en"
        onSetActiveModel={vi.fn()}
      />,
    );

    const base = await screen.findByRole('radio', { name: /whisper-base\.en/ });
    expect(base).toBeChecked();
  });

  it('hides the picker with a single installed model — one radio asks nothing', async () => {
    vi.mocked(api.listInstalledSttModels).mockResolvedValue({ models: [BASE] } as never);
    render(<AudioModelManager kind="stt" onSetActiveModel={vi.fn()} />);

    await screen.findByText('whisper-base.en');
    expect(screen.queryByRole('radio')).toBeNull();
  });
});
