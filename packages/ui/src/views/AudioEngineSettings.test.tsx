import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

vi.mock('../components/AudioModelManager.js', () => ({
  AudioModelManager: ({
    kind,
    disabledReason,
  }: {
    kind: 'stt' | 'tts';
    disabledReason?: string;
  }) => (
    <div data-testid={`model-manager-${kind}`} data-disabled-reason={disabledReason ?? ''}>
      mock-{kind}-manager
    </div>
  ),
}));

const { AudioEngineSettings } = await import('./AudioEngineSettings.js');
const { api } = await import('../api.js');

const READY_STATUS = {
  stt: { status: 'ok' as const, baseUrl: 'http://127.0.0.1:9009' },
  tts: { status: 'ok' as const, baseUrl: 'http://127.0.0.1:9010' },
};

describe('AudioEngineSettings', () => {
  beforeEach(() => {
    vi.mocked(api.getAudioEngineStatus).mockResolvedValue(READY_STATUS as never);
    vi.mocked(api.listAudioVoices).mockResolvedValue({
      voices: [
        { id: 'af_heart', name: 'Heart', language: 'en' },
        { id: 'af_breeze', name: 'Breeze', language: 'en' },
      ],
    } as never);
  });

  it('renders both engine sections with their model managers', async () => {
    render(<AudioEngineSettings />);
    await waitFor(() => {
      expect(screen.getByTestId('model-manager-stt')).toBeInTheDocument();
    });
    expect(screen.getByTestId('model-manager-tts')).toBeInTheDocument();
    expect(screen.getByText(/Speech-to-text \(whisper\.cpp\)/)).toBeInTheDocument();
    expect(screen.getByText(/Text-to-speech \(Kokoro\)/)).toBeInTheDocument();
  });

  it('shows the voice preview UI only when TTS is ready', async () => {
    vi.mocked(api.getAudioEngineStatus).mockResolvedValue({
      stt: { status: 'ok' },
      tts: { status: 'no-model' },
    } as never);
    render(<AudioEngineSettings />);
    await waitFor(() => {
      expect(screen.getByTestId('model-manager-tts')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Preview a voice/)).not.toBeInTheDocument();
  });

  it('preview button calls synthesizeSpeech with the typed text and selected voice', async () => {
    vi.mocked(api.synthesizeSpeech).mockResolvedValue({ b64Wav: 'AAA=' } as never);
    render(<AudioEngineSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Preview a voice/)).toBeInTheDocument();
    });

    // Switch the voice selector to af_breeze and update the text.
    const voiceSelect = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(voiceSelect, { target: { value: 'af_breeze' } });
    const textInput = screen.getByRole('textbox') as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(textInput);
    await user.type(textInput, 'hello world');

    await user.click(screen.getByRole('button', { name: /Preview/ }));

    await waitFor(() => {
      expect(api.synthesizeSpeech).toHaveBeenCalledWith({
        text: 'hello world',
        voice: 'af_breeze',
        inline: true,
      });
    });
  });

  it('disables the preview button while synthesizing', async () => {
    let resolveSynth!: (v: unknown) => void;
    vi.mocked(api.synthesizeSpeech).mockReturnValue(
      new Promise((r) => {
        resolveSynth = r;
      }) as never,
    );
    render(<AudioEngineSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Preview a voice/)).toBeInTheDocument();
    });

    const previewBtn = screen.getByRole('button', { name: /Preview/ }) as HTMLButtonElement;
    fireEvent.click(previewBtn);

    await waitFor(() => {
      expect(previewBtn).toBeDisabled();
      expect(previewBtn).toHaveTextContent(/Synthesizing/);
    });
    resolveSynth({ b64Wav: 'AAA=' });
  });

  it('surfaces a synth error inline', async () => {
    vi.mocked(api.synthesizeSpeech).mockRejectedValue(new Error('out of GPU memory'));
    render(<AudioEngineSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Preview a voice/)).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => {
      expect(screen.getByText(/out of GPU memory/)).toBeInTheDocument();
    });
  });

  it('passes a disabledReason to the STT manager when the engine is unreachable', async () => {
    vi.mocked(api.getAudioEngineStatus).mockResolvedValue({
      stt: { status: 'unreachable', baseUrl: 'http://127.0.0.1:9009' },
      tts: { status: 'ok' },
    } as never);
    render(<AudioEngineSettings />);
    await waitFor(() => {
      const stt = screen.getByTestId('model-manager-stt');
      expect(stt.getAttribute('data-disabled-reason')).toMatch(/not reachable/i);
    });
  });

  it('shows the not-configured guidance and disables the manager accordingly', async () => {
    vi.mocked(api.getAudioEngineStatus).mockResolvedValue({
      stt: { status: 'not-configured' },
      tts: { status: 'not-configured' },
    } as never);
    render(<AudioEngineSettings />);
    await waitFor(() => {
      expect(screen.getAllByText(/Engine isn't wired up/i).length).toBeGreaterThan(0);
    });
    const stt = screen.getByTestId('model-manager-stt');
    expect(stt.getAttribute('data-disabled-reason')).toMatch(/not wired up/i);
  });

  it('shows the status error when the engine probe rejects', async () => {
    vi.mocked(api.getAudioEngineStatus).mockRejectedValue(new Error('connection refused'));
    render(<AudioEngineSettings />);
    await waitFor(() => {
      expect(screen.getByText(/connection refused/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Couldn't reach the Gezel service/)).toBeInTheDocument();
  });
});
