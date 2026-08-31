import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const editorContext = vi.hoisted(() => ({
  activeView: 'raw' as 'raw' | 'wysiwyg' | 'preview',
  markdownDoc: null,
  markdownSource: '# Field notes\n\nA quiet morning in the workshop.',
  monacoEditor: {
    getSelection: () => ({ isEmpty: () => false }),
    getModel: () => ({ getValueInRange: () => 'a quiet morning' }),
  },
  tiptapEditor: null,
}));

const contextMenu = vi.hoisted(() => ({
  items: [] as Array<{
    id: string;
    label: string;
    when?: string;
    onSelect: (context: { selectedText: string }) => void | Promise<void>;
  }>,
}));

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('@bendyline/squisq-editor-react', () => ({
  useEditorContext: () => editorContext,
  useEditorContextMenuItems: (items: typeof contextMenu.items) => {
    contextMenu.items = [...items];
  },
}));
vi.mock('./document-narration-mp3.js', () => ({
  encodeWavAsMp3: vi.fn(async () => new Blob([], { type: 'audio/mpeg' })),
}));

const { DocumentNarration } = await import('./DocumentNarration.js');
const { encodeWavAsMp3 } = await import('./document-narration-mp3.js');
const { api } = await import('../api.js');

let lastAudio: MockAudio | null = null;

class MockAudio extends EventTarget {
  currentTime = 0;
  duration = 90;
  paused = true;
  src: string;

  constructor(src: string) {
    super();
    this.src = src;
    lastAudio = this;
  }

  async play(): Promise<void> {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
}

class MockBufferSource extends EventTarget {
  buffer: AudioBuffer | null = null;
  connect(): void {}
  start(): void {}
  stop(): void {}
}

class MockAudioContext {
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
  async decodeAudioData(): Promise<AudioBuffer> {
    return { duration: 5 } as AudioBuffer;
  }
  createBufferSource(): AudioBufferSourceNode {
    return new MockBufferSource() as unknown as AudioBufferSourceNode;
  }
}

function renderControl(projectId?: string) {
  return render(
    <div className="squisq-editor-shell">
      <div className="squisq-editor-content" data-testid="editor-content">
        document
      </div>
      <DocumentNarration fileName="notes.md" projectId={projectId} />
    </div>,
  );
}

describe('DocumentNarration', () => {
  beforeEach(() => {
    lastAudio = null;
    contextMenu.items = [];
    vi.stubGlobal('Audio', MockAudio);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:narration'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.mocked(api.synthesizeSpeechWithProgress).mockResolvedValue({
      artifactPath: 'artifacts/audio/tts.wav',
      b64Wav: 'UklGRg==',
      meta: {
        voice: 'af_heart',
        model: 'kokoro',
        sampleRate: 24_000,
        durationSeconds: 90,
        durationMs: 1,
      },
    } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('narrates the parsed document with the built-in TTS route', async () => {
    renderControl('project-1');

    fireEvent.click(screen.getByRole('button', { name: 'Narrate document' }));

    await waitFor(() => expect(api.synthesizeSpeechWithProgress).toHaveBeenCalledOnce());
    expect(api.synthesizeSpeechWithProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Field notes'),
        projectId: 'project-1',
        inline: true,
      }),
      expect.objectContaining({
        onProgress: expect.any(Function),
        onChunk: expect.any(Function),
      }),
      expect.any(AbortSignal),
    );
    expect(vi.mocked(api.synthesizeSpeechWithProgress).mock.calls[0]?.[0].text).not.toContain('#');
    expect(await screen.findByText('Document narration')).toBeInTheDocument();
    const download = screen.getByRole('button', { name: 'Download MP3' });
    expect(download).toBeInTheDocument();
    expect(download).toHaveTextContent('');
  });

  it('registers Narrate selection with the Squisq context menu', async () => {
    renderControl();

    const item = contextMenu.items.find((candidate) => candidate.id === 'gezel.narrate-selection');
    expect(item).toMatchObject({ label: 'Narrate selection', when: 'selection' });
    await act(async () => {
      await item?.onSelect({ selectedText: 'a quiet morning' });
    });

    await waitFor(() =>
      expect(api.synthesizeSpeechWithProgress).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'a quiet morning', inline: true }),
        expect.objectContaining({
          onProgress: expect.any(Function),
          onChunk: expect.any(Function),
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText('Selection narration')).toBeInTheDocument();
  });

  it('cancels an in-flight narration request', async () => {
    vi.mocked(api.synthesizeSpeechWithProgress).mockImplementation(
      () => new Promise(() => undefined) as never,
    );
    renderControl();

    fireEvent.click(screen.getByRole('button', { name: 'Narrate document' }));
    expect(await screen.findByText('Creating narration…')).toBeInTheDocument();
    const signal = vi.mocked(api.synthesizeSpeechWithProgress).mock.calls[0]?.[2];

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByLabelText('Narration controls')).toBeNull());
  });

  it('shows live sentence progress while narration is created', async () => {
    vi.mocked(api.synthesizeSpeechWithProgress).mockImplementation(
      (_body, callbacks) =>
        new Promise(() => {
          callbacks.onProgress({
            phase: 'synthesizing',
            completedCharacters: 50,
            totalCharacters: 100,
            completedChunks: 2,
          });
        }) as never,
    );
    renderControl();

    fireEvent.click(screen.getByRole('button', { name: 'Narrate document' }));

    const progress = await screen.findByRole('progressbar', { name: 'Creating narration' });
    expect(progress).toHaveAttribute('aria-valuenow', '50');
    expect(document.querySelector('.document-narration-progress-value')).toHaveTextContent('50%');
    expect(screen.getByText(/Starting speech/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('starts progressive playback once sentence generation is safely faster than playback', async () => {
    let now = 1000;
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.mocked(api.synthesizeSpeechWithProgress).mockImplementation(async (_body, callbacks) => {
      callbacks.onProgress({
        phase: 'synthesizing',
        completedCharacters: 25,
        totalCharacters: 100,
        completedChunks: 1,
      });
      await callbacks.onChunk?.({
        index: 0,
        b64Wav: 'UklGRg==',
        sampleRate: 24_000,
        durationSeconds: 5,
      });
      now = 2000;
      callbacks.onProgress({
        phase: 'synthesizing',
        completedCharacters: 50,
        totalCharacters: 100,
        completedChunks: 2,
      });
      await callbacks.onChunk?.({
        index: 1,
        b64Wav: 'UklGRg==',
        sampleRate: 24_000,
        durationSeconds: 5,
      });
      return new Promise(() => undefined) as never;
    });
    renderControl();

    fireEvent.click(screen.getByRole('button', { name: 'Narrate document' }));

    expect(await screen.findByText('Playing while creating…')).toBeInTheDocument();
    expect(screen.getByText(/0:10 buffered/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause narration' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('skips the finished audio backward and forward by 30 seconds', async () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Narrate document' }));
    await screen.findByText('Document narration');

    fireEvent.click(screen.getByRole('button', { name: 'Forward 30 seconds' }));
    expect(lastAudio?.currentTime).toBe(30);
    fireEvent.click(screen.getByRole('button', { name: 'Back 30 seconds' }));
    expect(lastAudio?.currentTime).toBe(0);
  });

  it('converts and downloads the narration as an MP3', async () => {
    let downloadedName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
      this: HTMLAnchorElement,
    ) {
      downloadedName = this.download;
    });
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Narrate document' }));
    await screen.findByText('Document narration');

    fireEvent.click(screen.getByRole('button', { name: 'Download MP3' }));

    await waitFor(() => expect(encodeWavAsMp3).toHaveBeenCalledOnce());
    expect(downloadedName).toBe('notes-document-narration.mp3');
  });
});
