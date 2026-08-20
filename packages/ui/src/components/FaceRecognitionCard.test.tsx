import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { FaceRecognitionCard } = await import('./FaceRecognitionCard.js');
const { api } = await import('../api.js');

type ConfigResponse = Awaited<ReturnType<typeof api.getConfig>>;

describe('FaceRecognitionCard', () => {
  beforeEach(() => {
    vi.mocked(api.getConfig).mockResolvedValue({} as ConfigResponse);
    vi.mocked(api.updateConfig).mockResolvedValue({} as ConfigResponse);
    vi.mocked(api.wipeFaceData).mockResolvedValue({ projects: 0, disabled: true });
  });

  it('reflects the stored opt-in state and saves toggles', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      faceRecognition: { enabled: true },
    } as ConfigResponse);
    render(<FaceRecognitionCard />);
    const toggle = await screen.findByRole('checkbox');
    await waitFor(() => expect(toggle).toBeChecked());

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({ faceRecognition: { enabled: false } }),
    );
    expect(toggle).not.toBeChecked();
  });

  it('reverts the toggle when saving fails', async () => {
    vi.mocked(api.updateConfig).mockRejectedValue(new Error('daemon unreachable'));
    render(<FaceRecognitionCard />);
    const toggle = await screen.findByRole('checkbox');
    await waitFor(() => expect(toggle).not.toBeDisabled());

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('daemon unreachable')).toBeInTheDocument());
    expect(toggle).not.toBeChecked();
  });

  it('erases face data only after explicit confirmation', async () => {
    vi.mocked(api.wipeFaceData).mockResolvedValue({ projects: 3, disabled: true });
    render(<FaceRecognitionCard />);
    await screen.findByRole('checkbox');

    fireEvent.click(screen.getByRole('button', { name: 'Turn off and erase face data' }));
    expect(api.wipeFaceData).not.toHaveBeenCalled();
    expect(screen.getByText('Erase all face data?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Erase face data' }));
    await waitFor(() => expect(api.wipeFaceData).toHaveBeenCalled());
    expect(await screen.findByText('Face data erased across 3 projects.')).toBeInTheDocument();
  });
});
