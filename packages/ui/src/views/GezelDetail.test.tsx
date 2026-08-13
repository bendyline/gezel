import type { GezelDetail as GezelDetailData } from '@bendyline/gezel';
import { poppetjeFromSeed } from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

vi.mock('@bendyline/squisq-editor-react', () => ({
  EditorShell: ({
    initialMarkdown,
    onChange,
    toolbarSlotAfterActions,
  }: {
    initialMarkdown: string;
    onChange?: (s: string) => void;
    toolbarSlotAfterActions?: React.ReactNode;
  }) => (
    <div data-testid="editor">
      <div data-testid="editor-initial">{initialMarkdown}</div>
      <button type="button" data-testid="editor-emit" onClick={() => onChange?.('new about')}>
        emit
      </button>
      <div data-testid="editor-toolbar">{toolbarSlotAfterActions}</div>
    </div>
  ),
  // GezelDetail's component tree reaches JsonEditor via TuningPanel —
  // not a workaround for any upstream bug, just a complete-the-mock
  // requirement of vi.mock factories.
  JsonEditor: () => null,
}));
vi.mock('@bendyline/squisq-editor-react/styles', () => ({}));

vi.mock('../components/transform/TransformToolbarButton.js', () => ({
  TransformToolbarButton: () => null,
}));
vi.mock('../components/FixedFunctionAboutPanel.js', () => ({
  FixedFunctionAboutPanel: () => <div data-testid="ff-panel" />,
}));
vi.mock('../components/GezelChatTab.js', () => ({
  GezelChatTab: () => <div data-testid="chat-tab" />,
}));
vi.mock('../components/GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));
vi.mock('../components/GezelTemplatePicker.js', () => ({
  GezelTemplatePicker: ({ onApply }: { onApply: (id: string, about: string) => Promise<void> }) => (
    <button
      type="button"
      data-testid="apply-template"
      onClick={() => void onApply('template', '# Template')}
    >
      apply template
    </button>
  ),
}));
vi.mock('../components/GrowthPanel.js', () => ({
  GrowthPanel: ({ gezel }: { gezel: GezelDetailData }) => (
    <div data-testid="growth-panel">{gezel.id}</div>
  ),
}));
vi.mock('../components/MemoriesTree.js', () => ({
  MemoriesTree: () => <div data-testid="memories-tree" />,
}));
vi.mock('../components/ModelPicker.js', () => ({
  EffortPicker: () => null,
}));
vi.mock('../components/ProviderModelSelect.js', () => ({
  ProviderModelSelect: () => null,
}));
vi.mock('../components/ToolsetsEditor.js', () => ({
  ToolsetsEditor: () => <div data-testid="toolsets-editor" />,
}));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));

const { GezelDetail } = await import('./GezelDetail.js');
const { api } = await import('../api.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Partial fixture — GezelDetailData has heavy fields (`updatedAt`, the
// full parsed gezel.md, `toolsMd`) the test never reads, and the mocked
// API doesn't echo back a real one. Double-cast through `unknown` is the
// standard escape for partial test stand-ins.
const DETAIL = {
  id: 'gz-maya',
  name: 'Maya',
  role: 'Researcher',
  about: '# Maya\n\nResearch assistant.',
  icon: null,
} as unknown as GezelDetailData;

const FIXED_FUNCTION_DETAIL = {
  ...DETAIL,
  id: 'gz-image',
  name: 'Maya Image',
  role: 'Image generator',
  fixedFunction: {
    tool: 'generate_image',
    promptKey: 'prompt',
  },
} as unknown as GezelDetailData;

// A variant carrying a resolved poppetje so the appearance panel renders
// its hero + enabled "Accessories…" affordance. Pin two wearable slots so
// the toggle-on / toggle-off assertions are deterministic.
const POP = {
  ...poppetjeFromSeed(7, { key: 'gz-maya', name: 'Maya' }),
  hat: null,
  dress: null,
  accessory: 'glasses' as const,
};
const DETAIL_WITH_POP = { ...DETAIL, poppetje: POP } as unknown as GezelDetailData;

describe('GezelDetail', () => {
  beforeEach(() => {
    vi.mocked(api.getGezel).mockResolvedValue(DETAIL);
    vi.mocked(api.updateGezelAbout).mockImplementation(
      async (id, body) => ({ ...DETAIL, id, about: body.source }) as GezelDetailData,
    );
    vi.mocked(api.renameGezel).mockImplementation(
      async (id, body) => ({ ...DETAIL, id, name: body.name }) as GezelDetailData,
    );
  });

  it('renders Loading… until getGezel resolves', async () => {
    let resolve!: (v: GezelDetailData) => void;
    vi.mocked(api.getGezel).mockReturnValue(
      new Promise<GezelDetailData>((r) => {
        resolve = r;
      }),
    );
    render(<GezelDetail gezelId="gz-maya" />);
    expect(screen.getByText(/Loading gezel/)).toBeInTheDocument();
    resolve(DETAIL);
  });

  it('renders the gezel name + role + editor with about content', async () => {
    render(<GezelDetail gezelId="gz-maya" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Maya' })).toBeInTheDocument();
    });
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'About' }));
    expect(screen.getByTestId('editor-initial')).toHaveTextContent('Research assistant.');
  });

  it('hides Toolsets and Memories for a fixed-function gezel', async () => {
    vi.mocked(api.listInstalledImageModels).mockResolvedValue({
      models: [
        {
          id: 'flux-1-schnell',
          name: 'FLUX.1 Schnell',
          approxSizeBytes: 8_000_000_000,
          installedAt: '2026-08-04T00:00:00.000Z',
        },
      ],
      defaultModel: 'flux-1-schnell',
    });
    vi.mocked(api.getGezel).mockResolvedValue(FIXED_FUNCTION_DETAIL);
    render(<GezelDetail gezelId="gz-image" />);
    await screen.findByRole('heading', { name: 'Maya Image' });

    expect(screen.queryByRole('tab', { name: 'Toolsets' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Memories' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Image · FLUX.1 Schnell')).toBeInTheDocument();
  });

  it('leaves Toolsets and Memories available for an ordinary gezel', async () => {
    render(<GezelDetail gezelId="gz-maya" />);
    await screen.findByRole('heading', { name: 'Maya' });

    expect(screen.getByRole('tab', { name: 'Toolsets' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Memories' })).toBeInTheDocument();
  });

  it('returns to Chat when switching from Toolsets to a fixed-function gezel', async () => {
    vi.mocked(api.getGezel).mockImplementation(async (id) =>
      id === 'gz-image' ? FIXED_FUNCTION_DETAIL : DETAIL,
    );
    const { rerender } = render(<GezelDetail gezelId="gz-maya" />);
    await screen.findByRole('heading', { name: 'Maya' });

    fireEvent.click(screen.getByRole('tab', { name: 'Toolsets' }));
    expect(screen.getByTestId('toolsets-editor')).toBeInTheDocument();

    rerender(<GezelDetail gezelId="gz-image" />);
    await screen.findByRole('heading', { name: 'Maya Image' });

    expect(screen.queryByTestId('toolsets-editor')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders an error fallback when getGezel rejects', async () => {
    vi.mocked(api.getGezel).mockRejectedValue(new Error('not found'));
    render(<GezelDetail gezelId="gz-missing" />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't open this gezel/)).toBeInTheDocument();
    });
    expect(screen.getByText(/not found/)).toBeInTheDocument();
  });

  it('clicking the name and pressing Enter renames via api.renameGezel', async () => {
    render(<GezelDetail gezelId="gz-maya" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Maya' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('heading', { name: 'Maya' }));
    const input = screen.getByDisplayValue('Maya') as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, 'Mai{Enter}');

    await waitFor(() => {
      expect(api.renameGezel).toHaveBeenCalledWith('gz-maya', { name: 'Mai' });
    });
  });

  it('typing in the about editor schedules a debounced save', async () => {
    render(<GezelDetail gezelId="gz-maya" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Maya' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('tab', { name: 'About' }));
    expect(screen.getByTestId('editor')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('editor-emit'));
    expect(api.updateGezelAbout).not.toHaveBeenCalled();

    // Real-timer debounce — the view schedules at 1000ms; wait a bit longer.
    await new Promise((r) => setTimeout(r, 1200));
    expect(api.updateGezelAbout).toHaveBeenCalledWith('gz-maya', { source: 'new about' });
  });

  it('serializes a template replacement behind an in-flight autosave', async () => {
    const firstSave = deferred<GezelDetailData>();
    vi.mocked(api.updateGezelAbout)
      .mockReturnValueOnce(firstSave.promise)
      .mockImplementation(async (id, body) => ({ ...DETAIL, id, about: body.source }));

    render(<GezelDetail gezelId="gz-maya" />);
    await screen.findByRole('heading', { name: 'Maya' });
    fireEvent.click(screen.getByRole('tab', { name: 'About' }));
    fireEvent.click(screen.getByTestId('editor-emit'));
    act(() => {
      void flushSerializedAutosave('gezel:gz-maya:about');
    });
    expect(api.updateGezelAbout).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('apply-template'));
    expect(api.updateGezelAbout).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve({ ...DETAIL, about: 'new about' });
    });
    await waitFor(() => expect(api.updateGezelAbout).toHaveBeenCalledTimes(2));
    expect(api.updateGezelAbout).toHaveBeenLastCalledWith('gz-maya', { source: '# Template' });
    await waitFor(() =>
      expect(screen.getByTestId('editor-initial')).toHaveTextContent('# Template'),
    );
  });

  it('waits for autosave before generating and adopts the generated about text', async () => {
    const firstSave = deferred<GezelDetailData>();
    vi.mocked(api.updateGezelAbout).mockReturnValueOnce(firstSave.promise);
    vi.mocked(api.generateGezelAbout).mockResolvedValue({
      ...DETAIL,
      about: '# Generated',
    });

    render(<GezelDetail gezelId="gz-maya" />);
    await screen.findByRole('heading', { name: 'Maya' });
    fireEvent.click(screen.getByRole('tab', { name: 'About' }));
    fireEvent.click(screen.getByTestId('editor-emit'));
    act(() => {
      void flushSerializedAutosave('gezel:gz-maya:about');
    });
    expect(api.updateGezelAbout).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Draft from role' }));
    expect(api.generateGezelAbout).not.toHaveBeenCalled();

    await act(async () => {
      firstSave.resolve({ ...DETAIL, about: 'new about' });
    });
    await waitFor(() =>
      expect(api.generateGezelAbout).toHaveBeenCalledWith('gz-maya', { role: 'Researcher' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('editor-initial')).toHaveTextContent('# Generated'),
    );
  });

  it('toggles a worn item on through the accessories dialog', async () => {
    vi.mocked(api.getGezel).mockResolvedValue(DETAIL_WITH_POP);
    vi.mocked(api.setGezelPoppetje).mockResolvedValue({ poppetje: { ...POP, hat: 'cap' } });
    render(<GezelDetail gezelId="gz-maya" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Maya' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    fireEvent.click(screen.getByRole('button', { name: /Accessories/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Maya's accessories/)).toBeInTheDocument();

    // Hat, Garment, Accessory — three slot tile sections. Pick the Cap hat
    // (always unlocked; growth gating disables level-locked tiles).
    const hatGroup = within(dialog).getByRole('radiogroup', { name: 'Hat' });
    fireEvent.click(within(hatGroup).getByRole('radio', { name: 'Cap' }));

    await waitFor(() => {
      expect(api.setGezelPoppetje).toHaveBeenCalledWith('gz-maya', {
        poppetje: expect.objectContaining({ hat: 'cap' }),
      });
    });
  });

  it('removes a worn item by selecting None (maps to null, not a physical edit)', async () => {
    vi.mocked(api.getGezel).mockResolvedValue(DETAIL_WITH_POP);
    vi.mocked(api.setGezelPoppetje).mockResolvedValue({ poppetje: { ...POP, accessory: null } });
    render(<GezelDetail gezelId="gz-maya" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Maya' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    fireEvent.click(screen.getByRole('button', { name: /Accessories/ }));
    const dialog = screen.getByRole('dialog');
    // Clear the accessory slot via its "None" tile → sends null.
    const accessoryGroup = within(dialog).getByRole('radiogroup', { name: 'Accessory' });
    fireEvent.click(within(accessoryGroup).getByRole('radio', { name: 'None' }));

    await waitFor(() => {
      expect(api.setGezelPoppetje).toHaveBeenCalledWith('gz-maya', {
        poppetje: expect.objectContaining({ accessory: null }),
      });
    });
  });

  it('refetches when gezelId prop changes', async () => {
    const { rerender } = render(<GezelDetail gezelId="gz-maya" />);
    await waitFor(() => {
      expect(api.getGezel).toHaveBeenCalledWith('gz-maya');
    });

    vi.mocked(api.getGezel).mockResolvedValue({ ...DETAIL, id: 'gz-bob', name: 'Bob' });
    rerender(<GezelDetail gezelId="gz-bob" />);

    await waitFor(() => {
      expect(api.getGezel).toHaveBeenCalledWith('gz-bob');
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Bob' })).toBeInTheDocument();
    });
  });

  it('keeps an old save completion from retargeting edits after a gezel change', async () => {
    const oldSave = deferred<GezelDetailData>();
    vi.mocked(api.getGezel).mockImplementation(async (id) =>
      id === 'gz-bob'
        ? ({ ...DETAIL, id: 'gz-bob', name: 'Bob', about: '# Bob' } as GezelDetailData)
        : DETAIL,
    );
    vi.mocked(api.updateGezelAbout)
      .mockReturnValueOnce(oldSave.promise)
      .mockImplementation(async (id, body) => ({ ...DETAIL, id, about: body.source }));

    const { rerender } = render(<GezelDetail gezelId="gz-maya" />);
    await screen.findByRole('heading', { name: 'Maya' });
    fireEvent.click(screen.getByRole('tab', { name: 'About' }));
    fireEvent.click(screen.getByTestId('editor-emit'));
    act(() => {
      void flushSerializedAutosave('gezel:gz-maya:about');
    });
    expect(api.updateGezelAbout).toHaveBeenCalledTimes(1);

    rerender(<GezelDetail gezelId="gz-bob" />);
    await screen.findByRole('heading', { name: 'Bob' });
    await act(async () => {
      oldSave.resolve({ ...DETAIL, about: 'new about' });
    });

    fireEvent.click(screen.getByTestId('editor-emit'));
    act(() => {
      void flushSerializedAutosave('gezel:gz-bob:about');
    });
    expect(api.updateGezelAbout).toHaveBeenCalledTimes(2);
    expect(api.updateGezelAbout).toHaveBeenLastCalledWith('gz-bob', { source: 'new about' });
  });

  it('opens the Growth tab', async () => {
    render(<GezelDetail gezelId="gz-maya" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Maya' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('tab', { name: /Growth/ }));
    expect(screen.getByTestId('growth-panel')).toHaveTextContent('gz-maya');
  });

  it('shows the pending dot on the Growth tab and the header level badge', async () => {
    vi.mocked(api.getGezel).mockResolvedValue({
      ...DETAIL,
      growth: { level: 3, pending: true },
    } as GezelDetailData);
    render(<GezelDetail gezelId="gz-maya" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Maya' })).toBeInTheDocument();
    });
    expect(screen.getByText('Lv 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Level-up pending')).toBeInTheDocument();
  });
});
