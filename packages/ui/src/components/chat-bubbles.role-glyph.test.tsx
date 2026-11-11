import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { roleGlyph } from './chat-bubbles.js';

describe('roleGlyph', () => {
  // A top-hat emoji sat beside the Meester's name against the no-emoji rule
  // (2026-11-09); the hat is drawn now.
  it('draws the Meester’s hat rather than an emoji', () => {
    const { container } = render(<div>{roleGlyph('Meester')}</div>);
    expect(container.querySelector('.msg-role-glyph-hat svg')).not.toBeNull();
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  // The star follows the project, not the role: a Builder working a project
  // alone is its main crew member as much as a crew lead is (2026-11-10).
  it('stars a project’s main crew member, whatever their role', () => {
    for (const role of ['Builder', 'Voorman', undefined]) {
      const { container, unmount } = render(<div>{roleGlyph(role, true)}</div>);
      expect(container.textContent).toBe('⭐');
      unmount();
    }
  });

  it('marks nobody else', () => {
    expect(roleGlyph('Reviewer')).toBeNull();
    expect(roleGlyph('Voorman')).toBeNull();
    expect(roleGlyph(undefined)).toBeNull();
  });
});
