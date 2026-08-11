import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const recognitionModel = {
  id: 'qwen3-vl-4b-q4',
  name: 'Qwen3-VL 4B',
  approxSizeBytes: 3.3 * GB,
  recoScore: 20,
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
  vi.mocked(api.listRecognitionCatalog).mockResolvedValue({ models: [recognitionModel] } as never);
  vi.mocked(api.listInstalledRecognitionModels).mockResolvedValue({ models: [] } as never);
  vi.mocked(api.checkModelDownloadSpace).mockImplementation((async ({
    sizeBytes,
  }: {
    sizeBytes: number;
  }) => ({
    known: true,
    ok: true,
    freeBytes: 80 * GB,
    requiredBytes: sizeBytes + 2 * GB,
    storageLocation: 'Gezel model storage' as const,
  })) as never);
}

describe('RecommendedMediaDownloads', () => {
  it('offers a download for every fitting media modality on a big-GPU device', async () => {
    seedApi({
      platform: 'win32',
      gpuVramBytes: 34 * GB,
      totalRamBytes: 64 * GB,
      usableBytes: 32 * GB,
    });
    render(<RecommendedMediaDownloads />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Download image model/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Download speech-to-text/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download text-to-speech/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download image reading/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download video model/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose downloads/ })).toBeInTheDocument();
  });

  it('hides the video model when the device lacks the VRAM floor', async () => {
    seedApi({
      platform: 'linux',
      gpuVramBytes: null,
      totalRamBytes: 32 * GB,
      usableBytes: 16 * GB,
    });
    render(<RecommendedMediaDownloads />);
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

    render(<RecommendedMediaDownloads />);

    expect(await screen.findByText('1.0 GB of 4.0 GB · 25%')).toBeInTheDocument();
    expect(screen.getByText('17.0 GB of 34.0 GB · 50%')).toBeInTheDocument();
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
    expect(screen.getByText('2.0 GB of 4.0 GB · 50%')).toBeInTheDocument();
  });

  it('reviews a size-aware default plan, leaves video out, and never starts a chat model', async () => {
    seedApi({
      platform: 'win32',
      gpuVramBytes: 34 * GB,
      totalRamBytes: 64 * GB,
      usableBytes: 32 * GB,
    });
    render(<RecommendedMediaDownloads />);

    fireEvent.click(await screen.findByRole('button', { name: /Choose downloads/ }));

    expect(screen.getByRole('alertdialog', { name: 'Review model downloads' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /FLUX\.2 Klein/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Qwen3-VL/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Whisper Base/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Kokoro/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Wan 2\.2/ })).not.toBeChecked();

    const defaultBytes =
      (2.46 + 0.25 + 2.5) * GB + recognitionModel.approxSizeBytes + 147_900_000 + 95_000_000;
    await waitFor(() =>
      expect(api.checkModelDownloadSpace).toHaveBeenCalledWith({
        sizeBytes: Math.ceil(defaultBytes),
      }),
    );
    const confirm = await screen.findByRole('button', { name: 'Download 4 models' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    await waitFor(() => expect(api.pullImageModel).toHaveBeenCalledTimes(1));
    expect(api.pullRecognitionModel).toHaveBeenCalledTimes(1);
    expect(api.pullAudioModel).toHaveBeenCalledTimes(2);
    expect(api.pullVideoModel).not.toHaveBeenCalled();
    expect(api.installMlxModel).not.toHaveBeenCalled();
    expect(api.installLlamaCppModel).not.toHaveBeenCalled();
  });

  it('requires an explicit checked plan and disk preflight for the large video model', async () => {
    seedApi({
      platform: 'win32',
      gpuVramBytes: 34 * GB,
      totalRamBytes: 64 * GB,
      usableBytes: 32 * GB,
    });
    render(<RecommendedMediaDownloads />);

    fireEvent.click(await screen.findByRole('button', { name: /Download video model/ }));
    expect(screen.getByRole('checkbox', { name: /Wan 2\.2/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /FLUX\.2 Klein/ })).not.toBeChecked();
    expect(screen.getByText('Large download')).toBeInTheDocument();
    await waitFor(() =>
      expect(api.checkModelDownloadSpace).toHaveBeenCalledWith({
        sizeBytes: Math.ceil(videoItem.manifest.approxSizeBytes),
      }),
    );
    expect(await screen.findByRole('button', { name: 'Download 1 model' })).toBeEnabled();
    expect(api.pullVideoModel).not.toHaveBeenCalled();
  });

  it('blocks confirmation when the model-store filesystem lacks space', async () => {
    seedApi({
      platform: 'win32',
      gpuVramBytes: 34 * GB,
      totalRamBytes: 64 * GB,
      usableBytes: 32 * GB,
    });
    vi.mocked(api.checkModelDownloadSpace).mockResolvedValue({
      known: true,
      ok: false,
      freeBytes: 2 * GB,
      requiredBytes: 12 * GB,
      storageLocation: 'Gezel model storage',
    } as never);
    render(<RecommendedMediaDownloads />);

    fireEvent.click(await screen.findByRole('button', { name: /Choose downloads/ }));
    expect(await screen.findByText(/Not enough free space/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download 4 models' })).toBeDisabled();
    expect(api.pullImageModel).not.toHaveBeenCalled();
  });

  it('offers explicit cancellation for a confirmed server-owned download', async () => {
    seedApi({
      platform: 'win32',
      gpuVramBytes: 34 * GB,
      totalRamBytes: 64 * GB,
      usableBytes: 32 * GB,
    });
    vi.mocked(api.pullImageModel).mockImplementation((() => new Promise<void>(() => {})) as never);
    render(<RecommendedMediaDownloads />);

    fireEvent.click(await screen.findByRole('button', { name: /Download image model/ }));
    const confirm = await screen.findByRole('button', { name: 'Download 1 model' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    const cancel = await screen.findByRole('button', {
      name: 'Cancel FLUX.2 Klein 4B download',
    });
    fireEvent.click(cancel);
    await waitFor(() => expect(api.cancelImagePull).toHaveBeenCalledWith('flux-2-klein-4b-q4'));
    expect(await screen.findByRole('button', { name: /Download image model/ })).toBeInTheDocument();
  });
});
