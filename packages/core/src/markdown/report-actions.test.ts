import { describe, expect, it } from 'vitest';
import {
  hasReportActionFence,
  parseReportActionBlock,
  parseReportActions,
  reportActionContentHash,
} from './report-actions.js';

const FIRE_BLOCK = `kind: fire-craftbook
id: nightly-audit
title: Run the accessibility audit
reason: Three templates changed.
craftbookId: a11y-audit
projectId: webshop`;

function doc(...fences: string[]): string {
  return [
    '# Night report',
    '',
    'Findings prose.',
    ...fences.map((body) => `\`\`\`gezel-action\n${body}\n\`\`\``),
    '',
  ].join('\n\n');
}

describe('parseReportActionBlock', () => {
  it('parses a well-formed fire-craftbook block', () => {
    const result = parseReportActionBlock(FIRE_BLOCK, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toMatchObject({
      kind: 'fire-craftbook',
      id: 'nightly-audit',
      craftbookId: 'a11y-audit',
      projectId: 'webshop',
    });
    expect(result.action.contentHash).toBe(reportActionContentHash(FIRE_BLOCK));
  });

  it('aliases kinds and keys, strips unknown keys, coerces params', () => {
    const result = parseReportActionBlock(
      [
        'kind: craftbook',
        'name: Rerun the review',
        'craftbook: code-review',
        'confidence: high',
        'params:',
        '  intensity: 3',
      ].join('\n'),
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.kind).toBe('fire-craftbook');
    expect(result.action.title).toBe('Rerun the review');
    expect(result.action).not.toHaveProperty('confidence');
    if (result.action.kind === 'fire-craftbook') {
      expect(result.action.craftbookId).toBe('code-review');
      expect(result.action.params).toEqual({ intensity: '3' });
    }
  });

  it('falls back to a content-hash id when none is authored', () => {
    const body = 'kind: create-task\ntitle: Fix it\nprompt: Do the thing carefully.';
    const result = parseReportActionBlock(body, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.id).toBe(`a-${reportActionContentHash(body)}`);
  });

  it('returns an issue (never throws) for non-mapping and invalid bodies', () => {
    const notYaml = parseReportActionBlock('- just\n- a list', 3);
    expect(notYaml.ok).toBe(false);
    if (!notYaml.ok) expect(notYaml.issue.index).toBe(3);

    const missing = parseReportActionBlock('kind: fire-craftbook\ntitle: No book id', 1);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issue.message).toContain('craftbookId');
  });

  it('normalizes apply-edits entries including the diff key alias', () => {
    const result = parseReportActionBlock(
      [
        'kind: apply-edits',
        'title: Harden headers',
        'edits:',
        '  - path: src/a.ts',
        '    diffArtifact: report/edits/a.diff',
        '  - path: src/b.ts',
        '    diff: report/edits/b.diff',
      ].join('\n'),
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.action.kind === 'apply-edits') {
      expect(result.action.edits).toEqual([
        { path: 'src/a.ts', diffArtifact: 'report/edits/a.diff' },
        { path: 'src/b.ts', diffArtifact: 'report/edits/b.diff' },
      ]);
    }
  });
});

describe('parseReportActions', () => {
  it('extracts only gezel-action fences, in order', () => {
    const markdown = [
      '# Report',
      '```ts',
      'const x = 1;',
      '```',
      '```gezel-action',
      FIRE_BLOCK,
      '```',
      '```mermaid',
      'flowchart LR',
      '```',
    ].join('\n');
    const { actions, issues } = parseReportActions(markdown);
    expect(actions).toHaveLength(1);
    expect(issues).toHaveLength(0);
    expect(actions[0]?.id).toBe('nightly-audit');
  });

  it('suffixes duplicate ids with a diagnostic', () => {
    const { actions, issues } = parseReportActions(doc(FIRE_BLOCK, FIRE_BLOCK));
    expect(actions.map((a) => a.id)).toEqual(['nightly-audit', 'nightly-audit-2']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('duplicate');
  });

  it('collects issues for malformed blocks alongside good ones', () => {
    const { actions, issues } = parseReportActions(doc(FIRE_BLOCK, 'kind: mystery\ntitle: Huh'));
    expect(actions).toHaveLength(1);
    expect(issues).toHaveLength(1);
  });

  it('ignores gezel-action text inside other fences', () => {
    const markdown = [
      '# Report',
      '````md',
      'Example:',
      '```gezel-action',
      'kind: fire-craftbook',
      '```',
      '````',
    ].join('\n');
    expect(parseReportActions(markdown).actions).toHaveLength(0);
    expect(hasReportActionFence(markdown)).toBe(false);
  });

  it('hasReportActionFence detects a real fence cheaply', () => {
    expect(hasReportActionFence(doc(FIRE_BLOCK))).toBe(true);
    expect(hasReportActionFence('# Plain report\n\nNo actions here.')).toBe(false);
  });

  it('handles an empty document', () => {
    expect(parseReportActions('')).toEqual({ actions: [], issues: [] });
  });
});
