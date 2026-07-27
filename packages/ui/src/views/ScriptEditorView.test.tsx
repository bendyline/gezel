import type { GetScriptSourceResponse, ScriptMeta } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

// Monaco (and the squisq form) can't run in jsdom — substitute a textarea
// for the whole three-tab editor that honors the same props + imperative
// handle the real ScriptEditorTabs exposes. This view only ever talks to the
// editor through that handle, so the tab internals are out of scope here.
vi.mock('../components/script-editor/ScriptEditorTabs.js', async () => {
  const React = await import('react');
  const ScriptEditorTabs = React.forwardRef(function MockEditor(
    props: {
      initialSource: string;
      readOnly?: boolean;
      onChangeContent?: (s: string) => void;
      onReady?: () => void;
    },
    ref: React.Ref<unknown>,
  ) {
    const [value, setValue] = React.useState(props.initialSource);
    const valueRef = React.useRef(value);
    valueRef.current = value;
    React.useImperativeHandle(ref, () => ({
      getValue: () => valueRef.current,
      setValue: (text: string) => {
        valueRef.current = text;
        setValue(text);
      },
      revealLine: () => {},
      focus: () => {},
      setServerDiagnostics: () => {},
    }));
    React.useEffect(() => {
      props.onReady?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <textarea
        aria-label="code"
        value={value}
        readOnly={props.readOnly}
        onChange={(e) => {
          valueRef.current = e.target.value;
          setValue(e.target.value);
          props.onChangeContent?.(e.target.value);
        }}
      />
    );
  });
  return { ScriptEditorTabs };
});

const { ScriptEditorView, __clearAllScriptDrafts } = await import('./ScriptEditorView.js');
const { api } = await import('../api.js');

const META: ScriptMeta = {
  name: 'summarize',
  description: 'Summarizes things for the task chat.',
  requires: ['llm', 'network'],
  outputs: { ok: { type: 'boolean', description: 'Done.' } },
} as ScriptMeta;

const SOURCE = "export const meta = defineScript({ name: 'summarize' });\n";

function sourceResponse(overrides: Partial<GetScriptSourceResponse> = {}): GetScriptSourceResponse {
  return {
    name: 'summarize',
    source: SOURCE,
    hash: 'hash-1',
    mtimeMs: 1,
    meta: META,
    ...overrides,
  };
}

describe('ScriptEditorView', () => {
  beforeEach(() => {
    vi.mocked(api.getProjectScriptSource).mockResolvedValue(sourceResponse() as never);
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [] } as never);
    vi.mocked(api.saveProjectScriptSource).mockResolvedValue({
      status: 'saved',
      hash: 'hash-2',
      metaOk: true,
      diagnostics: [],
    } as never);
    // Stale draft state can leak between tests via module scope — the
    // in-memory map survives localStorage.clear() and outlives the DOM.
    __clearAllScriptDrafts();
    window.localStorage.clear();
  });

  it('loads the script and renders name, description, and capability pills', async () => {
    render(<ScriptEditorView projectId="pj-1" scriptName="summarize" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'summarize' })).toBeInTheDocument();
    });
    // Header + About panel both show the description.
    expect(screen.getAllByText('Summarizes things for the task chat.').length).toBeGreaterThan(0);
    // Pills render in the header and again in the About panel's
    // "Allowed to" list — both phrasings must agree.
    expect(screen.getAllByText('Uses AI').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Internet').length).toBeGreaterThan(0);
    expect((screen.getByLabelText('code') as HTMLTextAreaElement).value).toBe(SOURCE);
  });

  it('marks the buffer dirty on edit and saves with the loaded baseHash', async () => {
    render(<ScriptEditorView projectId="pj-1" scriptName="summarize" />);
    const editor = await screen.findByLabelText('code');

    fireEvent.change(editor, { target: { value: `${SOURCE}// more\n` } });
    expect(await screen.findByText('● Unsaved')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.saveProjectScriptSource).toHaveBeenCalledWith('pj-1', {
        name: 'summarize',
        source: `${SOURCE}// more\n`,
        baseHash: 'hash-1',
      });
    });
    await waitFor(() => {
      expect(screen.queryByText('● Unsaved')).not.toBeInTheDocument();
    });
  });

  it('does not resurrect the draft when the debounced mirror write fires after a save', async () => {
    const view = render(<ScriptEditorView projectId="pj-1" scriptName="summarize" />);
    const editor = await screen.findByLabelText('code');
    fireEvent.change(editor, { target: { value: `${SOURCE}// more\n` } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByText('● Unsaved')).not.toBeInTheDocument();
    });

    // Past the 500ms draft-mirror debounce: a timer left running by the
    // save would write the buffer back and the next open would claim to
    // have restored changes that are already on disk.
    await new Promise((resolve) => setTimeout(resolve, 600));
    view.unmount();

    render(<ScriptEditorView projectId="pj-1" scriptName="summarize" />);
    await screen.findByLabelText('code');
    expect(screen.queryByText(/Restored your unsaved changes/)).not.toBeInTheDocument();
    expect(window.localStorage.getItem('gezel:script-draft:pj-1/summarize')).toBeNull();
  });

  it('shows the conflict banner with both resolutions on a conflicted save', async () => {
    vi.mocked(api.saveProjectScriptSource).mockResolvedValue({
      status: 'conflict',
      currentHash: 'hash-disk',
      currentSource: '// disk version\n',
    } as never);
    render(<ScriptEditorView projectId="pj-1" scriptName="summarize" />);
    const editor = await screen.findByLabelText('code');
    fireEvent.change(editor, { target: { value: '// mine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/changed on disk while you were editing/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload from disk' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overwrite with my version' })).toBeInTheDocument();

    // Reload swaps the buffer to the on-disk version and clears the banner.
    fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }));
    await waitFor(() => {
      expect(screen.queryByText(/changed on disk/)).not.toBeInTheDocument();
    });
    expect((screen.getByLabelText('code') as HTMLTextAreaElement).value).toBe('// disk version\n');
  });

  it('flags an invalid meta after save and keeps the script editable', async () => {
    vi.mocked(api.saveProjectScriptSource).mockResolvedValue({
      status: 'saved',
      hash: 'hash-3',
      metaOk: false,
      diagnostics: [{ severity: 'error', source: 'meta', message: 'meta did not validate' }],
    } as never);
    render(<ScriptEditorView projectId="pj-1" scriptName="summarize" />);
    const editor = await screen.findByLabelText('code');
    fireEvent.change(editor, { target: { value: 'broken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/meta block is invalid/)).toBeInTheDocument();
  });

  it('opens craftbook-managed scripts read-only with the copy-on-write banner', async () => {
    vi.mocked(api.getProjectScriptSource).mockResolvedValue(
      sourceResponse({
        source: `// @gezel-craftbook: pu/pull-request-review@1.0.0\n${SOURCE}`,
        provenance: { kind: 'craftbook', ref: 'pu/pull-request-review@1.0.0' },
      }) as never,
    );
    render(<ScriptEditorView projectId="pj-1" scriptName="summarize" />);

    expect(await screen.findByText(/Part of the pu\/pull-request-review/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make my own copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit anyway' })).toBeInTheDocument();
    expect((screen.getByLabelText('code') as HTMLTextAreaElement).readOnly).toBe(true);

    // Make my own copy → POST create without the marker + open the new tab.
    vi.mocked(api.createProjectScript).mockResolvedValue({
      name: 'summarize-custom',
      source: SOURCE,
      hash: 'h',
    } as never);
    const openTab = vi.fn();
    window.addEventListener('gezel:open-tab', openTab);
    fireEvent.click(screen.getByRole('button', { name: 'Make my own copy' }));
    await waitFor(() => {
      expect(api.createProjectScript).toHaveBeenCalledWith('pj-1', {
        name: 'summarize-custom',
        source: SOURCE,
      });
    });
    await waitFor(() => {
      expect(openTab).toHaveBeenCalled();
    });
    const detail = (openTab.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail).toMatchObject({ kind: 'script', projectId: 'pj-1', name: 'summarize-custom' });
    window.removeEventListener('gezel:open-tab', openTab);
  });

  it('lists task steps that use this script', async () => {
    vi.mocked(api.listProjectTasks).mockResolvedValue({
      tasks: [
        {
          ref: 'pj-1/3',
          title: 'Ship the arcade',
          craftbook: {
            steps: [
              { id: 's1', name: 'Plan', onEnter: { name: 'summarize' } },
              { id: 's2', name: 'Build' },
            ],
          },
        },
      ],
    } as never);
    render(<ScriptEditorView projectId="pj-1" scriptName="summarize" />);
    expect(await screen.findByText('Runs on 1 task step')).toBeInTheDocument();
  });
});
