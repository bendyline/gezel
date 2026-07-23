import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { VideoModelManager } = await import('./VideoModelManager.js');
const { api } = await import('../api.js');

const TWO_MODELS = {
  models: [
    {
      id: 'ltx-2.3-22b-fp8',
      name: 'LTX-2.3',
      approxSizeBytes: 1,
      installedAt: '2026-07-20T00:00:00Z',
    },
    {
      id: 'wan2.2-ti2v-5b',
      name: 'Wan 2.2 TI2V-5B',
      approxSizeBytes: 1,
      installedAt: '2026-07-17T00:00:00Z',
    },
  ],
};

describe('VideoModelManager active-model selection', () => {
  beforeEach(() => {
    vi.mocked(api.listInstalledVideoModels).mockResolvedValue(TWO_MODELS as never);
  });

  it('omits the Active column when no onSetActiveModel handler is given', async () => {
    render(<VideoModelManager />);

    await screen.findByText('ltx-2.3-22b-fp8');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Active' })).toBeNull();
  });

  it('marks the configured default active and persists a new pick', async () => {
    const onSet = vi.fn();
    render(
      <VideoModelManager configuredDefaultModelId="ltx-2.3-22b-fp8" onSetActiveModel={onSet} />,
    );

    const ltx = await screen.findByRole('radio', {
      name: 'Use ltx-2.3-22b-fp8 as the active video model',
    });
    const wan = screen.getByRole('radio', {
      name: 'Use wan2.2-ti2v-5b as the active video model',
    });
    expect(ltx).toBeChecked();
    expect(wan).not.toBeChecked();

    await userEvent.click(wan);
    expect(onSet).toHaveBeenCalledWith('wan2.2-ti2v-5b');
  });

  it('falls back to the first installed model when no default is configured', async () => {
    render(<VideoModelManager onSetActiveModel={vi.fn()} />);

    const ltx = await screen.findByRole('radio', { name: /ltx-2\.3-22b-fp8/ });
    expect(ltx).toBeChecked();
  });
});
