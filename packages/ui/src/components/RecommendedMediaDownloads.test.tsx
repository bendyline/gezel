import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { RecommendedMediaDownloads } = await import('./RecommendedMediaDownloads.js');
const { api } = await import('../api.js');

const GB = 1024 ** 3;

const imageItem = {
  manifest: {
    kind: 'image-model',
    id: 'flux-2-klein-4b-q4',
    name: 'FLUX.2 Klein 4B',
    recoScore: 20,
    licenseClass: 'open',
    approxSizeBytes: 2.46 * GB,
    minRamGB: 16,
    auxiliaryFiles: [{ sizeBytes: 0.25 * GB }, { sizeBytes: 2.5 * GB }],
  },
};
const videoItem = {
  manifest: {
    kind: 'video-model',
    id: 'wan2.2-ti2v-5b',
    name: 'Wan 2.2 TI2V-5B',
    recoScore: 20,
    licenseClass: 'open',
    approxSizeBytes: 34 * GB,
    minVramGB: 24,
  },
};
const audioCatalog = {
  stt: [
    {
      id: 'whisper-base.en',
      name: 'Whisper Base (English)',
      approxSizeBytes: 147_900_000,
      kind: 'stt',
      licenseClass: 'open',
      recoScore: 20,
    },
  ],
  tts: [
    {
      id: 'kokoro-82m-v1.0',
      name: 'Kokoro 82M v1.0',
      approxSizeBytes: 95_000_000,
      kind: 'tts',
      licenseClass: 'open',
      recoScore: 20,
    },
  ],
};

function seedApi(mem: {
  platform: string;
  gpuVramBytes: number | null;
  totalRamBytes: number;
  usableBytes: number;
}) {
  vi.mocked(api.getMemoryProfile).mockResolvedValue(mem as never);
  vi.mocked(api.listCatalogItems).mockImplementation(((kind: string) =>
    Promise.resolve({
      items: kind === 'image-model' ? [imageItem] : kind === 'video-model' ? [videoItem] : [],
    })) as never);
  vi.mocked(api.listAudioCatalog).mockResolvedValue(audioCatalog as never);
  vi.mocked(api.listInstalledImageModels).mockResolvedValue({ models: [] } as never);
  vi.mocked(api.listInstalledVideoModels).mockResolvedValue({ models: [] } as never);
  vi.mocked(api.listInstalledSttModels).mockResolvedValue({ models: [] } as never);
  vi.mocked(api.listInstalledTtsModels).mockResolvedValue({ models: [] } as never);
  vi.mocked(api.listActiveImagePulls).mockResolvedValue({ pulls: [] } as never);
  vi.mocked(api.listActiveVideoPulls).mockResolvedValue({ pulls: [] } as never);
}

describe('RecommendedMediaDownloads', () => {
  it('offers a download for every fitting media modality on a big-GPU device', async () => {
    seedApi({
      platform: 'win32',
      gpuVramBytes: 34 * GB,
      totalRamBytes: 64 * GB,
      usableBytes: 32 * GB,
    });
    render(<RecommendedMediaDownloads config={null} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Download image model/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Download speech-to-text/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download text-to-speech/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download video model/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download all recommended/ })).toBeInTheDocument();
  });

  it('hides the video model when the device lacks the VRAM floor', async () => {
    seedApi({
      platform: 'linux',
      gpuVramBytes: null,
      totalRamBytes: 32 * GB,
      usableBytes: 16 * GB,
    });
    render(<RecommendedMediaDownloads config={null} />);
    // Image (RAM 32 ≥ 16) + both audio still appear…
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Download image model/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Download speech-to-text/ })).toBeInTheDocument();
    // …but the 24 GB-VRAM video model is hidden on a GPU-less box.
    expect(screen.queryByRole('button', { name: /Download video model/ })).not.toBeInTheDocument();
  });

  it('reattaches progress bars for service-owned downloads when the view mounts again', async () => {
    seedApi({
      platform: 'win32',
      gpuVramBytes: 34 * GB,
      totalRamBytes: 64 * GB,
      usableBytes: 32 * GB,
    });
    vi.mocked(api.listActiveImagePulls).mockResolvedValue({
      pulls: [
        {
          id: 'flux-2-klein-4b-q4',
          startedAt: '2026-07-16T12:00:00.000Z',
          bytesWritten: 1 * GB,
          totalBytes: 4 * GB,
          finished: false,
        },
      ],
    } as never);
    vi.mocked(api.listActiveVideoPulls).mockResolvedValue({
      pulls: [
        {
          id: 'wan2.2-ti2v-5b',
          startedAt: '2026-07-16T12:00:00.000Z',
          bytesWritten: 17 * GB,
          totalBytes: 34 * GB,
          finished: false,
        },
      ],
    } as never);
    let onImageEvent: Parameters<typeof api.subscribeImagePull>[1] | null = null;
    vi.mocked(api.subscribeImagePull).mockImplementation(((
      _id: string,
      onEvent: Parameters<typeof api.subscribeImagePull>[1],
    ) => {
      onImageEvent = onEvent;
      return new Promise<void>(() => {});
    }) as never);
    vi.mocked(api.subscribeVideoPull).mockImplementation(
      (() => new Promise<void>(() => {})) as never,
    );

    render(<RecommendedMediaDownloads config={null} />);

    expect(await screen.findByText('1.1 GB of 4.3 GB · 25%')).toBeInTheDocument();
    expect(screen.getByText('18.3 GB of 36.5 GB · 50%')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download image model/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download video model/ })).not.toBeInTheDocument();
    expect(api.subscribeImagePull).toHaveBeenCalledWith(
      'flux-2-klein-4b-q4',
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(api.subscribeVideoPull).toHaveBeenCalledWith(
      'wan2.2-ti2v-5b',
      expect.any(Function),
      expect.any(AbortSignal),
    );

    act(() => {
      onImageEvent?.({ type: 'progress', bytesWritten: 2 * GB, totalBytes: 4 * GB });
    });
    expect(screen.getByText('2.1 GB of 4.3 GB · 50%')).toBeInTheDocument();
  });
});
