import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileSourceView } from './FileSourceView.js';

vi.mock('../../theme.js', () => ({ useEffectiveTheme: () => 'light' }));
vi.mock('@bendyline/squisq-editor-react', () => ({
  EditorShell: (props: {
    fileName?: string;
    readOnly?: boolean;
    showFormattingControls?: boolean;
  }) => (
    <div
      data-testid="editor-shell"
      data-file={props.fileName}
      data-readonly={String(Boolean(props.readOnly))}
      data-formatting={String(props.showFormattingControls ?? true)}
    />
  ),
  useEditorContext: () => ({ monacoEditor: null }),
}));
vi.mock('@bendyline/squisq-editor-react/styles', () => ({}));

const common = {
  findings: [],
  activeFinding: null,
  codeContext: null,
  onContextLink: () => false,
};

describe('FileSourceView', () => {
  it('shows a .txt file as typed, with its line breaks', () => {
    const text = 'Minimum order: $150.\nDeposit: 30%.\n\nLead time: 48 hours.';
    const { container } = render(
      <FileSourceView path="notes/policy.txt" content={text} {...common} />,
    );
    expect(container.querySelector('pre.plain-text-file')?.textContent).toBe(text);
    expect(screen.queryByTestId('editor-shell')).toBeNull();
  });

  it('reads other files in the editor without formatting keys', () => {
    render(<FileSourceView path="docs/notes.md" content="# Notes" {...common} />);
    const shell = screen.getByTestId('editor-shell');
    expect(shell).toHaveAttribute('data-readonly', 'true');
    expect(shell).toHaveAttribute('data-formatting', 'false');
  });
});
