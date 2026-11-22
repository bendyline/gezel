import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi({ exportProjectPage: vi.fn() }) }));
vi.mock('./DocumentExport/download-blob.js', () => ({ downloadBlob: vi.fn() }));

const { api } = await import('../api.js');
const { downloadBlob } = await import('./DocumentExport/download-blob.js');
const { ExportPageDialog } = await import('./ExportPageDialog.js');

describe('ExportPageDialog', () => {
  it('saves the chosen form and closes when nothing was left out', async () => {
    const blob = new Blob(['zip']);
    vi.mocked(api.exportProjectPage!).mockResolvedValue({ blob, filename: 'site.zip', notes: [] });
    const onClose = vi.fn();
    render(<ExportPageDialog open projectId="p1" path="site/index.html" onClose={onClose} />);

    fireEvent.click(screen.getByRole('radio', { name: /Folder \(\.zip\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() =>
      expect(api.exportProjectPage).toHaveBeenCalledWith('p1', 'site/index.html', 'folder'),
    );
    expect(downloadBlob).toHaveBeenCalledWith(blob, 'site.zip');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('says what the copy leaves out', async () => {
    vi.mocked(api.exportProjectPage!).mockResolvedValue({
      blob: new Blob(['<html>']),
      filename: 'site.html',
      notes: ['https://example.com/x.js is not in this copy; it loads from the internet.'],
    });
    render(<ExportPageDialog open projectId="p1" path="site/index.html" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/loads from the internet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });
});
