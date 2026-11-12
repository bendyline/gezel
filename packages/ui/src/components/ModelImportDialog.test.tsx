import type { ModelImportReview } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { ModelImportDialog } = await import('./ModelImportDialog.js');
const { api } = await import('../api.js');

vi.stubGlobal(
  'ResizeObserver',
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const GB = 1024 ** 3;

function review(overrides: Partial<ModelImportReview> = {}): ModelImportReview {
  return {
    source: {
      kind: 'huggingface',
      repo: 'someone/Tiny-Qwen-GGUF',
      revision: 'a'.repeat(40),
      url: 'https://huggingface.co/someone/Tiny-Qwen-GGUF',
    },
    engine: 'llama-cpp',
    id: 'hf-tiny-qwen-q4-k-m-abc123',
    name: 'Tiny Qwen (Q4_K_M)',
    license: 'apache-2.0',
    selectedFile: 'Tiny-Qwen-Q4_K_M.gguf',
    choices: [
      { key: 'Tiny-Qwen-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 5 * GB, fileCount: 1 },
      { key: 'Tiny-Qwen-Q8_0.gguf', quant: 'Q8_0', sizeBytes: 9 * GB, fileCount: 1 },
    ],
    details: {
      architecture: 'qwen3',
      parameterSize: '8B',
      contextWindow: 40_960,
      quantization: 'Q4_K_M',
      supportsTools: true,
      thinks: false,
      mixtureOfExperts: false,
    },
    tuning: { from: 'catalog', catalogId: 'qwen3-8b-q4', catalogName: 'Qwen3 8B' },
    downloadBytes: 5 * GB,
    checks: [
      { id: 'access', status: 'pass', title: 'Download access', detail: 'Anyone can download it.' },
      {
        id: 'architecture',
        status: 'pass',
        title: 'Engine support',
        detail: 'llama.cpp v0.9.0 supports the "qwen3" design.',
      },
    ],
    blocked: false,
    alreadyInstalled: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ModelImportDialog', () => {
  it('reviews a linked model on open and offers the download', async () => {
    vi.mocked(api.reviewModelImport).mockResolvedValue(review());
    render(
      <ModelImportDialog open initial={{ repo: 'someone/Tiny-Qwen-GGUF' }} onClose={() => {}} />,
    );
    expect(await screen.findByText('Tiny Qwen (Q4_K_M)')).toBeTruthy();
    expect(api.reviewModelImport).toHaveBeenCalledWith({ repo: 'someone/Tiny-Qwen-GGUF' });
    expect(screen.getByText('Engine support.')).toBeTruthy();
    const download = screen.getByRole('button', { name: 'Download 5.0 GB' }) as HTMLButtonElement;
    expect(download.disabled).toBe(false);
  });

  it('refuses the download while a check says Problem', async () => {
    vi.mocked(api.reviewModelImport).mockResolvedValue(
      review({
        blocked: true,
        checks: [
          {
            id: 'architecture',
            status: 'fail',
            title: 'Engine support',
            detail: 'This model uses the "xyz" design, which the engine cannot load.',
          },
        ],
      }),
    );
    render(
      <ModelImportDialog open initial={{ repo: 'someone/Tiny-Qwen-GGUF' }} onClose={() => {}} />,
    );
    expect(await screen.findByText('Problem')).toBeTruthy();
    const download = screen.getByRole('button', { name: 'Download 5.0 GB' }) as HTMLButtonElement;
    expect(download.disabled).toBe(true);
  });

  it('offers the tested catalog entry when it pins the same file', async () => {
    vi.mocked(api.reviewModelImport).mockResolvedValue(
      review({ catalogMatch: { id: 'tiny-qwen-q4', name: 'Tiny Qwen' } }),
    );
    render(
      <ModelImportDialog open initial={{ repo: 'someone/Tiny-Qwen-GGUF' }} onClose={() => {}} />,
    );
    expect(await screen.findByRole('button', { name: 'Download Tiny Qwen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download this upload' })).toBeTruthy();
  });

  it('confirms the reviewed file, then installs it like a catalog model', async () => {
    vi.mocked(api.reviewModelImport).mockResolvedValue(review());
    vi.mocked(api.confirmModelImport).mockResolvedValue({
      engine: 'llama-cpp',
      id: 'hf-tiny-qwen-q4-k-m-abc123',
      name: 'Tiny Qwen (Q4_K_M)',
    });
    vi.mocked(api.installLlamaCppModel).mockImplementation(async (_id, onEvent) => {
      onEvent({ type: 'progress', bytesWritten: GB, totalBytes: 5 * GB });
      onEvent({ type: 'done', id: 'hf-tiny-qwen-q4-k-m-abc123' });
    });
    const onInstalled = vi.fn();
    render(
      <ModelImportDialog
        open
        initial={{ repo: 'someone/Tiny-Qwen-GGUF' }}
        onClose={() => {}}
        onInstalled={onInstalled}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Download 5.0 GB' }));
    await waitFor(() =>
      expect(onInstalled).toHaveBeenCalledWith('hf-tiny-qwen-q4-k-m-abc123', 'llama-cpp'),
    );
    expect(api.confirmModelImport).toHaveBeenCalledWith({
      repo: 'someone/Tiny-Qwen-GGUF',
      revision: 'a'.repeat(40),
      file: 'Tiny-Qwen-Q4_K_M.gguf',
    });
    expect(await screen.findByText(/Gezel is now trying it/)).toBeTruthy();
  });

  it('starts from a pasted link and shows why one is refused', async () => {
    // The real client throws its HTTP status line and keeps the daemon's
    // sentence on `details`; the dialog must show the sentence.
    vi.mocked(api.reviewModelImport).mockRejectedValue(
      new GezelApiError('Gezel API error 422 on POST /api/model-imports/review', 422, {
        error: 'This repository has no model Gezel can run.',
      }),
    );
    render(<ModelImportDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Link to a model on Hugging Face/), {
      target: { value: 'someone/not-gguf' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check model' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This repository has no model Gezel can run.');
    expect(alert.textContent).not.toContain('Gezel API error');
    expect(api.reviewModelImport).toHaveBeenCalledWith({ reference: 'someone/not-gguf' });
  });

  it('says where the settings come from', async () => {
    vi.mocked(api.reviewModelImport).mockResolvedValue(review());
    render(
      <ModelImportDialog open initial={{ repo: 'someone/Tiny-Qwen-GGUF' }} onClose={() => {}} />,
    );
    expect(await screen.findByText(/borrowed from Qwen3 8B/)).toBeTruthy();
  });

  it('adds GGUF files from this computer without a download', async () => {
    const localReview = review({
      source: {
        kind: 'local-file',
        importId: 'imp-1',
        files: [{ name: 'Mine-Q4_K_M.gguf', sizeBytes: 5 * GB }],
      },
      id: 'local-mine-q4-k-m-abc123',
      name: 'Mine (Q4_K_M)',
      choices: [],
      checks: [{ id: 'integrity', status: 'pass', title: 'Checksums', detail: 'Recorded.' }],
    });
    vi.mocked(api.startLocalModelImport).mockResolvedValue({ importId: 'imp-1' });
    vi.mocked(api.uploadLocalModelFile).mockResolvedValue({
      name: 'Mine-Q4_K_M.gguf',
      sizeBytes: 5 * GB,
      sha256: 'f'.repeat(64),
    });
    vi.mocked(api.reviewLocalModelImport).mockResolvedValue(localReview);
    vi.mocked(api.confirmLocalModelImport).mockResolvedValue({
      engine: 'llama-cpp',
      id: 'local-mine-q4-k-m-abc123',
      name: 'Mine (Q4_K_M)',
      installed: true,
    });
    const onInstalled = vi.fn();
    render(<ModelImportDialog open onClose={() => {}} onInstalled={onInstalled} />);
    const file = new File([new Uint8Array(8)], 'Mine-Q4_K_M.gguf');
    fireEvent.change(screen.getByTestId('model-import-files'), { target: { files: [file] } });
    expect(await screen.findByText('Mine-Q4_K_M.gguf from this computer')).toBeTruthy();
    expect(api.uploadLocalModelFile).toHaveBeenCalledWith(
      'imp-1',
      file,
      'Mine-Q4_K_M.gguf',
      expect.anything(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add 5.0 GB' }));
    await waitFor(() =>
      expect(onInstalled).toHaveBeenCalledWith('local-mine-q4-k-m-abc123', 'llama-cpp'),
    );
    expect(api.installLlamaCppModel).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a GGUF before sending anything', async () => {
    render(<ModelImportDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('model-import-files'), {
      target: { files: [new File(['x'], 'notes.txt')] },
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(api.startLocalModelImport).not.toHaveBeenCalled();
  });
});
