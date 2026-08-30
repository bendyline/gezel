import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('@bendyline/squisq-editor-react', () => ({
  useEditorContext: () => editorContext,
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
    vi.stubGlobal('Audio', MockAudio);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:narration'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.mocked(api.synthesizeSpeech).mockResolvedValue({
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

    await waitFor(() => expect(api.synthesizeSpeech).toHaveBeenCalledOnce());
    expect(api.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Field notes'),
        projectId: 'project-1',
        inline: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(vi.mocked(api.synthesizeSpeech).mock.calls[0]?.[0].text).not.toContain('#');
    expect(await screen.findByText('Document narration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download MP3' })).toBeInTheDocument();
  });

  it('offers Narrate selection from the editor context menu', async () => {
    renderControl();

    fireEvent.contextMenu(screen.getByTestId('editor-content'), { clientX: 40, clientY: 60 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Narrate selection' }));

    await waitFor(() =>
      expect(api.synthesizeSpeech).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'a quiet morning', inline: true }),
      ),
    );
    expect(await screen.findByText('Selection narration')).toBeInTheDocument();
  });

  it('cancels an in-flight narration request', async () => {
    vi.mocked(api.synthesizeSpeech).mockImplementation(() => new Promise(() => undefined) as never);
    renderControl();

    fireEvent.click(screen.getByRole('button', { name: 'Narrate document' }));
    expect(await screen.findByText('Creating narration…')).toBeInTheDocument();
    const signal = vi.mocked(api.synthesizeSpeech).mock.calls[0]?.[0].signal;

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByLabelText('Narration controls')).toBeNull());
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
