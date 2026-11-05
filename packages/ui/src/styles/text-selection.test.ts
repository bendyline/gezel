import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom computes no cascade, so these guard the rules themselves: chrome is
// unselectable by default, and what people copy out of it opts back in.
const css = (name: string) => readFileSync(resolve(import.meta.dirname, name), 'utf8');

/** Selectors of every rule in the sheet whose body sets `user-select` to `value`. */
function selectorsSetting(stylesheet: string, value: 'none' | 'text'): string[] {
  return stylesheet
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .flatMap((rule) => {
      const [selector, body] = rule.split('{');
      return body && new RegExp(`(^|[;\\s])user-select:\\s*${value}`).test(body)
        ? [selector!.replace(/\s+/g, ' ').trim()]
        : [];
    });
}

describe('text selection', () => {
  const foundation = css('foundation.css');

  it('opts commands, paths, and error text back in across the app', () => {
    const optIn = selectorsSetting(foundation, 'text').find((selector) =>
      selector.includes('textarea'),
    );
    for (const selector of ['code', 'kbd', 'pre', 'samp', '[role="alert"]', '.error']) {
      expect(optIn).toContain(`${selector},`);
    }
    expect(optIn).toContain('.gz-selectable-text');
  });

  it('keeps those inside a control part of the control', () => {
    const guard = selectorsSetting(foundation, 'none').find((selector) =>
      selector.endsWith(':where(code, kbd, samp, [role="alert"], .error)'),
    );
    expect(guard).toMatch(/^:where\(button, select, summary, \[role="button"\]/);
    // The guard must follow the opt-in: both have zero specificity.
    expect(foundation.indexOf(':where(code, kbd, samp')).toBeGreaterThan(
      foundation.indexOf('.gz-selectable-text'),
    );
  });

  it('keeps a failed turn and an install-health notice copyable', () => {
    const chat = selectorsSetting(css('shared-content.css'), 'text');
    expect(chat.some((selector) => selector.includes('.msg-failed-banner'))).toBe(true);
    expect(selectorsSetting(css('app-shell.css'), 'text')).toContain('.settings-notice');
  });
});
