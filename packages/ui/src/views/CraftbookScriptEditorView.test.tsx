import type { GetScriptSourceResponse } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

    expect(await screen.findByRole('heading', { name: 'qualityGate' })).toBeInTheDocument();
    expect((screen.getByLabelText('craftbook script source') as HTMLTextAreaElement).value).toBe(
      SOURCE,
    );
    expect(api.createCraftbookScript).not.toHaveBeenCalled();
  });

  it('scaffolds a missing script and then loads it', async () => {
    vi.mocked(api.getCraftbookScriptSource)
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce(sourceResponse() as never);

    render(<CraftbookScriptEditorView craftbookId="review" scriptName="qualityGate" />);

    await screen.findByRole('heading', { name: 'qualityGate' });
    expect(api.createCraftbookScript).toHaveBeenCalledWith('review', { name: 'qualityGate' });
    expect(api.getCraftbookScriptSource).toHaveBeenCalledTimes(2);
  });

  it('saves edited source with optimistic concurrency', async () => {
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
