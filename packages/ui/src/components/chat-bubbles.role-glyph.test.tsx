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

  it('marks no other role but the crew lead', () => {
    expect(roleGlyph('Reviewer')).toBeNull();
    expect(roleGlyph(undefined)).toBeNull();
  });
});
