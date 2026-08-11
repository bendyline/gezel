import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('./ModelBundleControls.js', () => ({
  useExportModelBundle: () => ({ run: async () => {}, busy: false, error: null }),
}));

const { ModelActionsMenu, ModelContextSliderPanel } = await import('./ModelContextControls.js');
const { api } = await import('../api.js');

const GiB = 1024 ** 3;

// A qwen3.6-27b-class row on a 24 GB card: 64K auto grant, exact KV slope.
const MODEL = {
  id: 'qwen3.6-27b-q4',
  approxSizeBytes: 17_100_000_000,
  contextWindow: 262_144,
  effectiveContextWindow: 81_920,
  kvBytesPerTokenPerSlot: 36_864,
  kvFixedBytesPerSlot: 0,
  weightsResidentBytes: 20_520_000_000,
  plannedSlots: 1,
};

describe('ModelActionsMenu', () => {
  it('offers fitness, context, export, update, and delete for an ordinary row', () => {
    const onRunFitnessCheck = vi.fn();
    render(
      <ModelActionsMenu
        engine="llama-cpp"
        model={{ ...MODEL, updateAvailable: true }}
        contextSupported
        contextEditorOpen={false}
        onToggleContextEditor={() => {}}
        fitnessAction={{ label: 'Re-run fitness check', onRun: onRunFitnessCheck }}
        onUpdate={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByRole('menuitem', { name: 'Context size…' })).toBeEnabled();
    const fitness = screen.getByRole('menuitem', { name: 'Re-run fitness check' });
    fireEvent.click(fitness);
    expect(onRunFitnessCheck).toHaveBeenCalledOnce();
    expect(screen.getByRole('menuitem', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Update' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('hides Delete for machine models and Context size when unsupported', () => {
    render(
      <ModelActionsMenu
        engine="llama-cpp"
        model={{ ...MODEL, readOnly: true }}
        contextSupported={false}
        contextEditorOpen={false}
        onToggleContextEditor={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.queryByRole('menuitem', { name: 'Context size…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Export' })).toBeInTheDocument();
  });

  it('disables Context size when the model has no window to adjust', () => {
    render(
      <ModelActionsMenu
        engine="llama-cpp"
        model={{ id: 'tiny', approxSizeBytes: GiB, contextWindow: 8_192 }}
        contextSupported
        contextEditorOpen={false}
        onToggleContextEditor={() => {}}
      />,
    );
    expect(screen.getByRole('menuitem', { name: 'Context size…' })).toBeDisabled();
  });
});

describe('ModelContextSliderPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.updateModelContextOverride).mockResolvedValue({
      modelId: MODEL.id,
      contextTokens: 131_072,
    } as never);
    vi.mocked(api.getEngineStatus).mockResolvedValue({
      enforced: true,
      budgetBytes: 60 * GiB,
      committedBytes: 0,
      pools: {
        kind: 'discrete-gpu',
        vramBytes: 24 * GiB,
        ramShareBytes: 38 * GiB,
        fastBytes: 22.8 * GiB,
      },
    } as never);
  });

  it('prices the dragged window live and saves the override', async () => {
    render(<ModelContextSliderPanel engine="llama-cpp" model={MODEL} />);

    // Follows automatic at the granted window until dragged.
    expect(screen.getByText('Automatic')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    const slider = screen.getByRole('slider', { name: `Context size for ${MODEL.id}` });
    fireEvent.change(slider, { target: { value: String(131_072) } });

    // weights 20.52 GB + 36,864 B/token × 131,072 tokens ≈ 25.4 GB.
    expect(screen.getByText(/~23\.6 GB in memory/)).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateModelContextOverride).toHaveBeenCalledWith('llama-cpp', MODEL.id, 131_072),
    );
    expect(await screen.findByText(/applies when the model next starts/)).toBeInTheDocument();
  });

  it('marks the automatic grant on the track and returns to it explicitly', async () => {
    render(
      <ModelContextSliderPanel
        engine="llama-cpp"
        model={{ ...MODEL, overrideContextTokens: 131_072, autoContextWindow: 81_920 }}
      />,
    );

    expect(screen.getByText(/Auto · 80K/)).toBeInTheDocument();
    const back = screen.getByRole('button', { name: 'Back to automatic' });
    fireEvent.click(back);
    await waitFor(() =>
      expect(api.updateModelContextOverride).toHaveBeenCalledWith('llama-cpp', MODEL.id, null),
    );
  });

  it('warns when the chosen window exceeds the fast pool instead of blocking', async () => {
    render(<ModelContextSliderPanel engine="llama-cpp" model={MODEL} />);
    const slider = screen.getByRole('slider', { name: `Context size for ${MODEL.id}` });
    // 262,144 tokens × 36,864 B ≈ 9.7 GB of KV on top of 20.5 GB of weights —
    // past the 22.8 GB fast pool the engine status advertises.
    fireEvent.change(slider, { target: { value: String(262_144) } });
    expect(await screen.findByText(/Bigger than what fits right now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it("does not count the model's own resident reservation against its pool", async () => {
    // The loaded model IS the committed bytes: without the own-reservation
    // subtraction, its slider warned "bigger than what fits" while sitting
    // at the automatic position it was admitted at.
    vi.mocked(api.getEngineStatus).mockResolvedValue({
      enforced: true,
      budgetBytes: 60 * GiB,
      committedBytes: 21.5 * GiB,
      entries: [
        {
          key: `llama-cpp:${MODEL.id}:0`,
          provider: 'llama-cpp',
          modelId: MODEL.id,
          replicaIdx: 0,
          residentBytes: 21.5 * GiB,
          lastUsedAt: 0,
          createdAt: 0,
        },
      ],
      pools: {
        kind: 'discrete-gpu',
        vramBytes: 24 * GiB,
        ramShareBytes: 38 * GiB,
        fastBytes: 22.8 * GiB,
      },
    } as never);

    render(<ModelContextSliderPanel engine="llama-cpp" model={MODEL} />);
    const slider = screen.getByRole('slider', { name: `Context size for ${MODEL.id}` });
    fireEvent.change(slider, { target: { value: String(81_920) } });
    // Give the status fetch a tick to land, then confirm no false warning.
    await waitFor(() => expect(api.getEngineStatus).toHaveBeenCalled());
    expect(screen.queryByText(/Bigger than what fits right now/)).not.toBeInTheDocument();
  });

  it('says so rather than pretending an estimate for an unmeasured ds4 model', () => {
    render(
      <ModelContextSliderPanel
        engine="ds4"
        model={{
          id: 'deepseek-v4-flash',
          approxSizeBytes: 150 * GiB,
          contextWindow: 1_000_000,
          contextCeilingTokens: 262_144,
          effectiveContextWindow: 131_072,
        }}
      />,
    );
    expect(screen.getByText(/memory-per-token yet/)).toBeInTheDocument();
    expect(screen.queryByText(/in memory/)).not.toBeInTheDocument();
    // The slider's max is the catalog launch ceiling, not the native window.
    expect(screen.getByRole('slider', { name: /deepseek-v4-flash/ })).toHaveAttribute(
      'max',
      String(262_144),
    );
  });

  it('prices a ds4 drag from the catalog-authored KV slope', () => {
    // ds4's footprint is dominated by the routed-expert cache, so the whole
    // point of the readout is that a 128K -> 256K drag is ~1 GB, not ~35 GB.
    // A row that quoted the flat catalog target here would tell the user
    // nothing about the choice they're making.
    render(
      <ModelContextSliderPanel
        engine="ds4"
        model={{
          id: 'deepseek-v4-flash',
          approxSizeBytes: 81 * GiB,
          contextWindow: 1_000_000,
          contextCeilingTokens: 262_144,
          effectiveContextWindow: 131_072,
          weightsResidentBytes: 35 * GiB,
          kvFixedBytesPerSlot: 0,
          kvBytesPerTokenPerSlot: 8192,
        }}
      />,
    );
    // 35 GiB + 8192 B x 131072 = 36.0 GB at the automatic window.
    expect(screen.getByText(/~36\.0 GB in memory/)).toBeInTheDocument();
    expect(screen.getByText(/8 MB per 1K tokens/)).toBeInTheDocument();
    expect(screen.queryByText(/memory-per-token yet/)).not.toBeInTheDocument();
  });
});
