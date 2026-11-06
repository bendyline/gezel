import { EditorShell } from '@bendyline/squisq-editor-react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GEZEL_WRITE_CANVAS } from './write-canvas.js';

describe('GEZEL_WRITE_CANVAS', () => {
  it('sets Write in the app sans instead of the theme fonts', async () => {
    const { container } = render(
      <EditorShell {...GEZEL_WRITE_CANVAS} initialMarkdown={'# Heading\n\nBody'} />,
    );
    await new Promise((r) => setTimeout(r, 80));

    const host = container.querySelector<HTMLElement>('[data-theme-inheritance]');
    expect(host?.dataset.themeInheritance).toBe('none');
    expect(host?.style.getPropertyValue('--squisq-theme-title-font')).toBe('');

    const canvas = [...container.querySelectorAll<HTMLElement>('[style]')].find(
      (el) => el.style.getPropertyValue('--squisq-write-header-font') !== '',
    );
    expect(canvas?.style.getPropertyValue('--squisq-write-header-font')).toBe('var(--font-ui)');
    expect(canvas?.style.getPropertyValue('--squisq-write-body-font')).toBe('var(--font-ui)');
  });
});
