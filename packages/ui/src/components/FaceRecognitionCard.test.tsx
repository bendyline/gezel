import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('./ConfirmDialog.js', () => ({
  ConfirmDialog: ({
    open,
    title,
    message,
    confirmLabel,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    message?: ReactNode;
    confirmLabel?: string;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  }) =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <p>{message}</p>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={() => void onConfirm()}>
          {confirmLabel ?? 'Confirm'}
        </button>
      </div>
    ) : null,
}));

const { api } = await import('../api.js');
const { FaceRecognitionCard } = await import('./FaceRecognitionCard.js');

type ConfigResponse = Awaited<ReturnType<typeof api.getConfig>>;

describe('FaceRecognitionCard', () => {
  beforeEach(() => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      faceRecognition: { enabled: false },
    } as unknown as ConfigResponse);
    vi.mocked(api.updateConfig).mockResolvedValue({
      provider: 'mock',
    } as unknown as ConfigResponse);
    vi.mocked(api.wipeFaceData).mockResolvedValue({ projects: 0, disabled: true });
  });

  it('reflects the stored opt-in state and saves toggles', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      faceRecognition: { enabled: true },
    } as unknown as ConfigResponse);
    render(<FaceRecognitionCard />);

    const toggle = await screen.findByRole('checkbox', { name: 'Recognize people in photos' });
    await waitFor(() => expect(toggle).toBeChecked());

    await user.click(toggle);

    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({ faceRecognition: { enabled: false } }),
    );
    expect(toggle).not.toBeChecked();
  });

  it('reverts the toggle and explains when saving fails', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateConfig).mockRejectedValueOnce(new Error('daemon unreachable'));
    render(<FaceRecognitionCard />);

    const toggle = await screen.findByRole('checkbox', { name: 'Recognize people in photos' });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.getByText('daemon unreachable')).toBeInTheDocument();
  });

  it('erases face data only after confirmation and reports affected projects', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      faceRecognition: { enabled: true },
    } as unknown as ConfigResponse);
    vi.mocked(api.wipeFaceData).mockResolvedValue({ projects: 3, disabled: true });
    render(<FaceRecognitionCard />);

    const toggle = await screen.findByRole('checkbox', { name: 'Recognize people in photos' });
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(screen.getByRole('button', { name: 'Turn off and erase face data' }));

    expect(api.wipeFaceData).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Erase all face data?' });
    await user.click(screen.getByRole('button', { name: 'Erase face data' }));

    await waitFor(() => expect(api.wipeFaceData).toHaveBeenCalledTimes(1));
    expect(dialog).not.toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Face data erased across 3 projects.')).toBeInTheDocument();
  });
});
