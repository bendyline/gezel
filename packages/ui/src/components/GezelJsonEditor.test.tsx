import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@bendyline/squisq-editor-react', () => ({
  JsonEditor: ({
    theme,
    surface,
    className,
  }: {
    theme?: { id?: string };
    surface?: { id?: string };
    className?: string;
  }) => (
    <div
      data-testid="json-editor"
      data-theme-id={theme?.id}
      data-surface-id={surface?.id}
      className={className}
    />
  ),
}));

const { GEZEL_JSON_EDITOR_THEME_ID, GezelJsonEditor } = await import('./GezelJsonEditor.js');

describe('GezelJsonEditor', () => {
  it("uses Squisq's gezellig theme", () => {
    render(<GezelJsonEditor schema={{ type: 'object' }} value={{}} className="consumer-form" />);

    const editor = screen.getByTestId('json-editor');
    expect(editor).toHaveAttribute('data-theme-id', GEZEL_JSON_EDITOR_THEME_ID);
    expect(editor).not.toHaveAttribute('data-surface-id');
    expect(editor).toHaveClass('gezel-json-editor', 'consumer-form');
  });
});
