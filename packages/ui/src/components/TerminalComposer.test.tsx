import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('./CommandsPanel.js', () => ({ CommandsPanel: () => null }));
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

  it('fires the current command from the right side of the toolbar', async () => {
    const { container } = render(
      <TerminalComposer projectId="project-1" workingDir="/work/project" />,
    );
    const editor = await screen.findByLabelText('Terminal command');
    const fire = screen.getByRole('button', { name: 'Fire' });

    expect(fire).toBe(container.querySelector('.terminal-composer-toolbar')?.lastElementChild);
    expect(fire).toHaveClass('terminal-toolbar-fire-btn');

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
});
