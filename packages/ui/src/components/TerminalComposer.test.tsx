import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('./CommandsPanel.js', () => ({
  CommandsPanel: ({ section }: { section?: string }) => <div data-testid={`gallery-${section}`} />,
}));
vi.mock('./terminal-editor/use-terminal-completion-sources.js', () => ({
  useTerminalCompletionSources: () => undefined,
}));

vi.mock('./terminal-editor/TerminalCodeEditor.js', async () => {
  const React = await import('react');
  const TerminalCodeEditor = React.forwardRef(function MockTerminalCodeEditor(
    props: {
      initialValue: string;
      onChange?(value: string): void;
    },
    ref: React.Ref<unknown>,
  ) {
    const [value, setValue] = React.useState(props.initialValue);
    const valueRef = React.useRef(value);
    valueRef.current = value;
    const inputRef = React.useRef<HTMLTextAreaElement>(null);

    React.useImperativeHandle(ref, () => ({
      getValue: () => valueRef.current,
      setValue: (text: string) => {
        valueRef.current = text;
        setValue(text);
      },
      focus: () => inputRef.current?.focus(),
    }));

    return (
      <textarea
        ref={inputRef}
        aria-label="Terminal command"
        value={value}
        onChange={(event) => {
          valueRef.current = event.target.value;
          setValue(event.target.value);
          props.onChange?.(event.target.value);
        }}
      />
    );
  });
  return { default: TerminalCodeEditor };
});

const { TerminalComposer } = await import('./TerminalComposer.js');
const { api } = await import('../api.js');

describe('TerminalComposer', () => {
  beforeEach(() => {
    vi.mocked(api.runTerminalCommand).mockResolvedValue({} as never);
  });

  it('fires the current command from its own row over the entry', async () => {
    const { container } = render(
      <TerminalComposer projectId="project-1" workingDir="/work/project" />,
    );
    const editor = await screen.findByLabelText('Terminal command');
    // The key is glyph-only, so `aria-label` is the whole accessible name —
    // finding it by role here is also what guards that label from going away.
    const fire = screen.getByRole('button', { name: 'Fire' });

    // Fire belongs in the row above the entry (where chat puts Send), not back
    // in the toolbar beside the galleries.
    expect(container.querySelector('.terminal-composer-fire-row')).toContainElement(fire);
    expect(fire).toHaveClass('terminal-fire-btn');
    expect(container.querySelector('.terminal-composer-toolbar')).not.toContainElement(fire);

    fireEvent.change(editor, { target: { value: '  pnpm test  ' } });
    fireEvent.click(fire);

    await waitFor(() => {
      expect(api.runTerminalCommand).toHaveBeenCalledWith('project-1', {
        workingDir: '/work/project',
        input: 'pnpm test',
      });
    });
    expect(editor).toHaveValue('');
    expect(editor).toHaveFocus();
  });

  it('keeps all three toolbar galleries, including craftbooks', async () => {
    // The chat rail's narrowed Skills tab no longer lists commands, scripts,
    // or craftbooks — these three popovers are now their only home, so a
    // regression here silently removes the craftbook launcher entirely.
    // (The Popover mock renders content unconditionally, so all three mount.)
    render(<TerminalComposer projectId="project-1" workingDir="/work/project" />);
    await screen.findByLabelText('Terminal command');

    expect(screen.getByTestId('gallery-commands')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-scripts')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-tasks')).toBeInTheDocument();
  });

  it('carries the expand key just before the mode tabs, as chat does', async () => {
    const onExpandedChange = vi.fn();
    const { container, rerender } = render(
      <TerminalComposer
        projectId="project-1"
        workingDir="/work/project"
        toolbarTrailing={<div data-testid="mode-tabs" />}
        onExpandedChange={onExpandedChange}
      />,
    );
    await screen.findByLabelText('Terminal command');

    const toggle = screen.getByTestId('terminal-composer-expand');
    expect(toggle.nextElementSibling).toBe(screen.getByTestId('mode-tabs'));
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('.terminal-composer')).not.toHaveAttribute(
      'data-composer-expanded',
    );

    fireEvent.click(toggle);
    expect(onExpandedChange).toHaveBeenCalledWith(true);

    rerender(
      <TerminalComposer
        projectId="project-1"
        workingDir="/work/project"
        toolbarTrailing={<div data-testid="mode-tabs" />}
        expanded
        onExpandedChange={onExpandedChange}
      />,
    );
    expect(container.querySelector('.terminal-composer')).toHaveAttribute(
      'data-composer-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Collapse the terminal' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('has no expand key when nothing owns the size', async () => {
    render(<TerminalComposer projectId="project-1" workingDir="/work/project" />);
    await screen.findByLabelText('Terminal command');

    expect(screen.queryByTestId('terminal-composer-expand')).toBeNull();
  });
});
