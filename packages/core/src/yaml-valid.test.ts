import { describe, expect, it } from 'vitest';
import { yamlValid } from './yaml-valid.js';

describe('yamlValid', () => {
  it('accepts a rules file, across documents', () => {
    const rules = [
      'groups:',
      '  - name: checkout',
      '    rules:',
      '      - alert: HighErrorRate',
      '        expr: rate(http_errors_total[5m]) > 0.05',
      '        for: 10m',
      '---',
      'groups: []',
    ].join('\n');
    expect(yamlValid(rules)).toEqual({ ok: true });
  });

  it('names the parse error in a broken file', () => {
    // A value with an unquoted colon, the shape of qwen3.8-27b's alerts.yaml (2026-11-02).
    const broken = ['groups:', '  - name: checkout', '    summary: rate: too high'].join('\n');
    const result = yamlValid(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/line 3/);
  });

  it('refuses prose, a comment-only file and a fenced block, which parse as strings or nothing', () => {
    expect(yamlValid('Here are the alert rules you asked for.').ok).toBe(false);
    expect(yamlValid('# only a comment').ok).toBe(false);
    expect(yamlValid('```yaml\ngroups: []\n```').ok).toBe(false);
  });
});
