import { describe, expect, it } from 'vitest';
import { pageComponentsSource } from './page-components.js';
import { pageDemoChatSource } from './page-demo-chat.js';

function componentCss(): string {
  const literal = /var css=("(?:[^"\\]|\\.)*");/.exec(pageComponentsSource())?.[1];
  expect(literal).toBeDefined();
  return JSON.parse(literal!) as string;
}

describe('page component colors', () => {
  it('fills a primary key with the deep terracotta at night, not the pale accent', () => {
    const css = componentCss();
    const dark = /:host\(\[data-theme="dark"\]\)\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(dark).toContain('--action:var(--gezel-component-accent,#8c4428)');
    // The lifted accent stays for rings and tints.
    expect(dark).toContain('--accent:var(--gezel-component-accent,#e0b78b)');
    expect(css).toContain('--on-action:#fffaf3');
    expect(pageComponentsSource()).toContain(
      '.primary{background:var(--action);border-color:var(--action);color:var(--on-action)',
    );
  });

  it("draws the demo conversation's Send key in the same action color", () => {
    expect(pageDemoChatSource()).toContain('.send{min-height:44px;background:var(--action,');
  });
});

describe('page conversation under a page modal', () => {
  it('stays valid script', () => {
    expect(() => new Function(pageComponentsSource())).not.toThrow();
  });

  it('reports the modal to the host instead of hiding the conversation', () => {
    const source = pageComponentsSource();
    expect(source).toContain('remote.position(rect,dim)');
    // The layout no longer empties the conversation's panel while a dialog is open.
    expect(source).not.toContain('mount.style.visibility=visibility');
  });
});
