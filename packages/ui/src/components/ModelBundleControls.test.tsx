import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelBundleExportProgress } from '../api.js';
import { ExportModelBundleButton } from './ModelBundleControls.js';

type NativeExportModelBundle = NonNullable<NonNullable<Window['__GEZEL__']>['exportModelBundle']>;
type NativeExportResult = Awaited<ReturnType<NativeExportModelBundle>>;

describe('model bundle export progress', () => {
  let publishProgress: ((progress: ModelBundleExportProgress) => void) | undefined;
  let finishExport: ((result: NativeExportResult) => void) | undefined;
  let exportModelBundle: ReturnType<typeof vi.fn>;
  let cancelModelBundleExport: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    publishProgress = undefined;
    finishExport = undefined;
    exportModelBundle = vi.fn(
      () =>
        new Promise((resolve) => {
          finishExport = resolve;
        }),
    );
    cancelModelBundleExport = vi.fn(async () => ({ ok: true as const }));
    window.__GEZEL__ = {
      token: 'test-token',
      exportModelBundle: exportModelBundle as unknown as NativeExportModelBundle,
      cancelModelBundleExport: cancelModelBundleExport as NonNullable<
        NonNullable<Window['__GEZEL__']>['cancelModelBundleExport']
      >,
      onModelBundleExportProgress: (callback) => {
        publishProgress = callback;
        return () => {
          publishProgress = undefined;
        };
      },
    };
  });

  it('stays open through prepare, write, verify, and verified completion', async () => {
    render(<ExportModelBundleButton engine="llama-cpp" id="large-model" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(exportModelBundle).toHaveBeenCalledOnce());
    const exportId = exportModelBundle.mock.calls[0]?.[2] as string;
    act(() => {
      publishProgress?.({ exportId, filename: 'large-model.gezmodel', phase: 'preparing' });
    });
    expect(screen.getByRole('dialog', { name: 'Exporting large-model.gezmodel' })).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Preparing model bundle' })).not.toHaveAttribute(
      'value',
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();

    act(() => {
      publishProgress?.({
        exportId,
        filename: 'large-model.gezmodel',
        phase: 'writing',
        bytesCompleted: 40,
        bytesTotal: 100,
      });
    });
    expect(screen.getByRole('progressbar', { name: 'Model bundle write progress' })).toHaveValue(
      40,
    );
    expect(screen.getByText(/writing$/)).toBeInTheDocument();

    act(() => {
      publishProgress?.({
        exportId,
        filename: 'large-model.gezmodel',
        phase: 'verifying',
        bytesCompleted: 75,
        bytesTotal: 100,
      });
    });
    expect(
      screen.getByRole('progressbar', { name: 'Model bundle verification progress' }),
    ).toHaveValue(75);
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();

    act(() => {
      finishExport?.({
        ok: true,
        path: '/exports/large-model.gezmodel',
        bytesWritten: 120,
        verified: true,
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Model exported' })).toBeVisible();
    });
    expect(screen.getByText(/verified every bundled file/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancels the active native export and closes after partial-file cleanup', async () => {
    render(<ExportModelBundleButton engine="llama-cpp" id="large-model" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(exportModelBundle).toHaveBeenCalledOnce());
    const exportId = exportModelBundle.mock.calls[0]?.[2] as string;
    act(() => {
      publishProgress?.({ exportId, filename: 'large-model.gezmodel', phase: 'preparing' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelModelBundleExport).toHaveBeenCalledWith(exportId));
    expect(screen.getByRole('button', { name: 'Canceling…' })).toBeDisabled();

    act(() => {
      finishExport?.({ ok: true, canceled: true });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
  });
});
