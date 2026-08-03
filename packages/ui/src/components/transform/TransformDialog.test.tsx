import type { TransformStreamEvent, TransformTextRequest } from '@bendyline/gezel';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionSnapshot } from './types.js';

let lastBody: TransformTextRequest | null = null;
let lastOnEvent: ((event: TransformStreamEvent) => void) | null = null;

vi.mock('../../api.js', () => ({
  api: {
    transformTextStream: vi.fn(
      (body: TransformTextRequest, onEvent: (event: TransformStreamEvent) => void) => {
        lastBody = body;
        lastOnEvent = onEvent;
        return new Promise<void>(() => {});
      },
    ),
    getConfig: vi.fn().mockResolvedValue({ klerkGezelId: 'klerk-1' }),
    listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'klerk-1', name: 'Lukas' }] }),
  },
}));

vi.mock('../GezelIcon.js', () => ({
  GezelIcon: ({ name, pulsing }: { name: string; pulsing?: boolean }) => (
    <span data-testid="klerk-icon" data-pulsing={pulsing ? 'true' : 'false'}>
      {name}
    </span>
  ),
}));

vi.mock('./TransformBeforeView.js', () => ({
  TransformBeforeView: ({ markdown }: { markdown: string }) => (
    <div data-testid="before-view">{markdown}</div>
  ),
}));

vi.mock('./TransformAfterEditor.js', () => ({
  TransformAfterEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (next: string) => void;
    ariaLabel: string;
  }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('./TransformThinkingFeed.js', () => ({
  TransformThinkingFeed: ({ markdown }: { markdown: string }) => (
    <div data-testid="thinking-feed">{markdown}</div>
  ),
}));

vi.mock('./TransformDiffPane.js', () => ({
  TransformDiffPane: ({
    original,
    value,
    onChange,
  }: {
    original: string;
    value: string;
    onChange: (next: string) => void;
  }) => (
    <div data-testid="diff-pane" data-original={original}>
      <textarea
        aria-label="Diff modified text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  ),
}));

const { TransformDialog } = await import('./TransformDialog.js');

const rewriteSnapshot: SelectionSnapshot = {
  mode: 'rewrite',
  view: 'wysiwyg',
  text: 'Original selected prose.',
  tiptapRange: { from: 3, to: 27 },
};

const insertSnapshot: SelectionSnapshot = {
  mode: 'insert',
  view: 'wysiwyg',
  text: '',
  tiptapRange: { from: 3, to: 3 },
  textBefore: 'Intro ends here.',
  textAfter: 'Next section starts.',
};

function renderDialog(
  snapshot: SelectionSnapshot,
  overrides: { onApply?: (text: string) => void; onClose?: () => void } = {},
) {
  const onApply = overrides.onApply ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  render(
    <TransformDialog snapshot={snapshot} context="generic" onApply={onApply} onClose={onClose} />,
  );
  return { onApply, onClose };
}

function transformButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Transform with/ });
}

beforeEach(() => {
  lastBody = null;
  lastOnEvent = null;
  vi.clearAllMocks();
});

describe('TransformDialog', () => {
  it('rewrite mode shows the selected text and allows transforming without an instruction', () => {
    renderDialog(rewriteSnapshot);
    expect(screen.getByText('Original selected prose.')).toBeInTheDocument();
    expect(transformButton()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('insert mode requires an instruction before transforming', () => {
    renderDialog(insertSnapshot);
    expect(screen.getByText(/New text will be inserted at the cursor/)).toBeInTheDocument();
    expect(transformButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/What should be written/), {
      target: { value: 'write a summary' },
    });
    expect(transformButton()).toBeEnabled();

    fireEvent.click(transformButton());
    expect(lastBody).toMatchObject({
      mode: 'insert',
      text: '',
      instruction: 'write a summary',
      textBefore: 'Intro ends here.',
      textAfter: 'Next section starts.',
    });
  });

  it('streams metacommentary while working and enables Apply on done', async () => {
    renderDialog(rewriteSnapshot);
    fireEvent.click(transformButton());
    expect(lastOnEvent).not.toBeNull();

    act(() => {
      lastOnEvent?.({ type: 'thinking-delta', text: 'weighing tone' });
    });
    expect(screen.getByText('weighing tone')).toBeInTheDocument();
    expect(screen.getByTestId('klerk-icon').dataset.pulsing).toBe('true');

    act(() => {
      lastOnEvent?.({ type: 'done', text: 'Improved prose.' });
    });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(screen.getByLabelText('Rewritten text')).toHaveValue('Improved prose.');
  });

  it('applies hand-edited result text, not the raw model output', async () => {
    const { onApply } = renderDialog(rewriteSnapshot);
    fireEvent.click(transformButton());
    act(() => {
      lastOnEvent?.({ type: 'done', text: 'Model output.' });
    });

    fireEvent.change(screen.getByLabelText('Rewritten text'), {
      target: { value: 'Hand-tuned output.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith('Hand-tuned output.');
  });

  it('preserves edits when toggling between the edit and diff views', () => {
    renderDialog(rewriteSnapshot);
    fireEvent.click(transformButton());
    act(() => {
      lastOnEvent?.({ type: 'done', text: 'Model output.' });
    });

    fireEvent.change(screen.getByLabelText('Rewritten text'), {
      target: { value: 'Edited in textarea.' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Diff' }));
    const diffPane = screen.getByTestId('diff-pane');
    expect(diffPane.dataset.original).toBe('Original selected prose.');
    expect(screen.getByLabelText('Diff modified text')).toHaveValue('Edited in textarea.');

    fireEvent.change(screen.getByLabelText('Diff modified text'), {
      target: { value: 'Edited in diff.' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Before / After' }));
    expect(screen.getByLabelText('Rewritten text')).toHaveValue('Edited in diff.');
  });

  it('cancel closes without applying anything', () => {
    const { onApply, onClose } = renderDialog(rewriteSnapshot);
    fireEvent.click(transformButton());
    act(() => {
      lastOnEvent?.({ type: 'done', text: 'Model output.' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('surfaces stream errors and keeps Apply disabled', () => {
    renderDialog(rewriteSnapshot);
    fireEvent.click(transformButton());
    act(() => {
      lastOnEvent?.({ type: 'error', error: 'engine exploded' });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('engine exploded');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });
});
