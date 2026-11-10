import type { GetScriptSourceResponse } from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

vi.mock('../components/script-editor/ScriptEditorTabs.js', async () => {
  const React = await import('react');
  const ScriptEditorTabs = React.forwardRef(function MockEditor(
    props: { initialSource: string; onChangeContent?: (source: string) => void },
    ref: React.Ref<unknown>,
  ) {
    const [value, setValue] = React.useState(props.initialSource);
    const valueRef = React.useRef(value);
    valueRef.current = value;
    React.useImperativeHandle(ref, () => ({
      getValue: () => valueRef.current,
      setServerDiagnostics: vi.fn(),
    }));
    return (
      <textarea
        aria-label="craftbook script source"
        value={value}
        onChange={(event) => {
          valueRef.current = event.target.value;
          setValue(event.target.value);
          props.onChangeContent?.(event.target.value);
        }}
      />
    );
  });
  return { ScriptEditorTabs };
});

const { CraftbookScriptEditorView } = await import('./CraftbookScriptEditorView.js');
const { api } = await import('../api.js');

const SOURCE = "export const meta = defineScript({ name: 'qualityGate' });\n";

function sourceResponse(): GetScriptSourceResponse {
  return {
    name: 'qualityGate',
    source: SOURCE,
    hash: 'hash-1',
    mtimeMs: 1,
    meta: { name: 'qualityGate', description: 'Checks quality.' },
  };
}

describe('CraftbookScriptEditorView', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.mocked(api.getCraftbookScriptSource).mockResolvedValue(sourceResponse() as never);
    vi.mocked(api.createCraftbookScript).mockResolvedValue({} as never);
    vi.mocked(api.saveCraftbookScriptSource).mockResolvedValue({
      status: 'saved',
      hash: 'hash-2',
      diagnostics: [],
    } as never);
  });

  it('loads an existing script without scaffolding it again', async () => {
    render(<CraftbookScriptEditorView craftbookId="review" scriptName="qualityGate" />);

    expect(await screen.findByLabelText('craftbook script source')).toHaveValue(SOURCE);
    expect(screen.getByRole('heading', { name: 'qualityGate' })).toBeInTheDocument();
    expect(api.createCraftbookScript).not.toHaveBeenCalled();
  });

  it('scaffolds a missing script and then loads it', async () => {
    vi.mocked(api.getCraftbookScriptSource)
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce(sourceResponse() as never);

    render(<CraftbookScriptEditorView craftbookId="review" scriptName="qualityGate" />);

    await screen.findByLabelText('craftbook script source');
    expect(api.createCraftbookScript).toHaveBeenCalledWith('review', { name: 'qualityGate' });
    expect(api.getCraftbookScriptSource).toHaveBeenCalledTimes(2);
  });

  it('saves edited source with optimistic concurrency', async () => {
    const navigate = vi.spyOn(window, 'dispatchEvent');
    render(<CraftbookScriptEditorView craftbookId="review" scriptName="qualityGate" />);
    const editor = await screen.findByLabelText('craftbook script source');
    const changed = `${SOURCE}// tightened\n`;

    fireEvent.change(editor, { target: { value: changed } });
    expect(screen.getByText(/unsaved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(api.saveCraftbookScriptSource).toHaveBeenCalledWith('review', {
        name: 'qualityGate',
        source: changed,
        baseHash: 'hash-1',
      });
    });
    await waitFor(() => expect(screen.queryByText(/unsaved/)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Back to plan' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gezel:open-tab',
        detail: { kind: 'craftbook', id: 'review' },
      }),
    );
  });

  it('returns directly to the parent craftbook without saving an unchanged script', async () => {
    const navigate = vi.spyOn(window, 'dispatchEvent');
    render(<CraftbookScriptEditorView craftbookId="review" scriptName="qualityGate" />);
    await screen.findByLabelText('craftbook script source');

    fireEvent.click(screen.getByRole('button', { name: 'Back to plan' }));

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gezel:open-tab',
        detail: { kind: 'craftbook', id: 'review' },
      }),
    );
    expect(api.saveCraftbookScriptSource).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps a way back while loading and after a load failure', async () => {
    vi.mocked(api.getCraftbookScriptSource).mockRejectedValueOnce(new Error('not found'));
    vi.mocked(api.createCraftbookScript).mockRejectedValueOnce(new Error('Cannot load script'));
    const navigate = vi.spyOn(window, 'dispatchEvent');
    render(<CraftbookScriptEditorView craftbookId="review" scriptName="qualityGate" />);

    expect(screen.getByRole('button', { name: 'Back to plan' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await screen.findByText('Cannot load script');
    fireEvent.click(screen.getByRole('button', { name: 'Back to plan' }));

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { kind: 'craftbook', id: 'review' } }),
    );
  });

  it('protects unsaved edits until the user chooses to discard and return', async () => {
    const navigate = vi.spyOn(window, 'dispatchEvent');
    render(<CraftbookScriptEditorView craftbookId="review" scriptName="qualityGate" />);
    const editor = await screen.findByLabelText('craftbook script source');
    fireEvent.change(editor, { target: { value: '// unsaved draft\n' } });

    fireEvent.click(screen.getByRole('button', { name: 'Back to plan' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(editor).toHaveValue('// unsaved draft\n');
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Back to plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes and return' }));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { kind: 'craftbook', id: 'review' } }),
    );
    expect(api.saveCraftbookScriptSource).not.toHaveBeenCalled();
  });

  it('does not warn about edits that have been reverted', async () => {
    const navigate = vi.spyOn(window, 'dispatchEvent');
    render(<CraftbookScriptEditorView craftbookId="review" scriptName="qualityGate" />);
    const editor = await screen.findByLabelText('craftbook script source');
    fireEvent.change(editor, { target: { value: '// temporary edit\n' } });
    fireEvent.change(editor, { target: { value: SOURCE } });

    fireEvent.click(screen.getByRole('button', { name: 'Back to plan' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { kind: 'craftbook', id: 'review' } }),
    );
  });

  it('waits for an in-flight save and protects edits made during that save', async () => {
    let finishSave!: () => void;
    vi.mocked(api.saveCraftbookScriptSource).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      return { status: 'saved', hash: 'hash-2', metaOk: true, diagnostics: [] };
    });
    render(<CraftbookScriptEditorView craftbookId="review" scriptName="qualityGate" />);
    const editor = await screen.findByLabelText('craftbook script source');
    fireEvent.change(editor, { target: { value: '// first edit\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Back to plan' })).toBeDisabled();
    fireEvent.change(editor, { target: { value: '// newer edit\n' } });

    await act(async () => finishSave());
    expect(editor).toHaveValue('// newer edit\n');
    fireEvent.click(screen.getByRole('button', { name: 'Back to plan' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('surfaces an on-disk conflict without clearing the dirty buffer', async () => {
    vi.mocked(api.saveCraftbookScriptSource).mockResolvedValue({
      status: 'conflict',
      currentHash: 'hash-disk',
      currentSource: '// disk\n',
    } as never);
    render(<CraftbookScriptEditorView craftbookId="review" scriptName="qualityGate" />);
    const editor = await screen.findByLabelText('craftbook script source');
    fireEvent.change(editor, { target: { value: '// mine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/changed on disk/)).toBeInTheDocument();
    expect(screen.getByText(/unsaved/)).toBeInTheDocument();
  });
});
