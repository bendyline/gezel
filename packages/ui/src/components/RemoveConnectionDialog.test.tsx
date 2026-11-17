import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { RemoveConnectionDialog } = await import('./RemoveConnectionDialog.js');
const { api } = await import('../api.js');

describe('RemoveConnectionDialog', () => {
  beforeEach(() => {
    vi.mocked(api.connectorStoredData).mockReset();
  });

  it('keeps what the connection downloaded unless the person ticks the box', async () => {
    vi.mocked(api.connectorStoredData).mockResolvedValue({
      files: 1654,
      bytes: 26 * 1024 * 1024,
    } as never);
    const onConfirm = vi.fn(async () => {});
    render(
      <RemoveConnectionDialog
        projectId="p1"
        binding={{ id: 'mail-outlook:1' }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    expect(
      await screen.findByText(
        '1,654 files, 26 MB, in this project. The originals at the source stay where they are.',
      ),
    ).toBeTruthy();
    expect(api.connectorStoredData).toHaveBeenCalledWith('p1', 'mail-outlook:1');
    expect(screen.getByText(/What it downloaded stays in the project\./)).toBeTruthy();

    const box = screen.getByRole('checkbox', { name: 'Also delete what it downloaded' });
    expect((box as HTMLInputElement).checked).toBe(false);
    await userEvent.click(box);
    expect(screen.getByText(/and everything it downloaded into this project\./)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove and delete' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(true));
  });

  it('plain Remove keeps the data', async () => {
    vi.mocked(api.connectorStoredData).mockResolvedValue({ files: 3, bytes: 900 } as never);
    const onConfirm = vi.fn(async () => {});
    render(
      <RemoveConnectionDialog
        projectId="p1"
        binding={{ id: 'rss:1' }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await screen.findByText(/3 files, 900 B/);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(false));
  });

  it('offers nothing to delete when nothing was downloaded', async () => {
    vi.mocked(api.connectorStoredData).mockResolvedValue({ files: 0, bytes: 0 } as never);
    render(
      <RemoveConnectionDialog
        projectId="p1"
        binding={{ id: 'rss:1' }}
        onConfirm={async () => {}}
        onCancel={() => {}}
      />,
    );
    expect(await screen.findByText(/It has not downloaded anything\./)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('keeps the camera wording and asks nothing about its records', async () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <RemoveConnectionDialog
        projectId="p1"
        binding={{ id: 'camera:1', driver: 'device' }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/This stops the camera/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(api.connectorStoredData).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(false));
  });
});
