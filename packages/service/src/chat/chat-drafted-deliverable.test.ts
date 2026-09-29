import { describe, expect, it } from 'vitest';
import {
  buildChatCodedFileNudge,
  buildProseDeliverableNudge,
  detectChatCodedFileWithoutWrite,
  detectProseDeliverableWithoutWrite,
} from './chat-drafted-deliverable.js';

describe('detectChatCodedFileWithoutWrite', () => {
  const bigHtml = `Here's the file:\n\`\`\`html\n<!DOCTYPE html>\n<html><body>\n${'<div>row</div>\n'.repeat(60)}</body></html>\n\`\`\``;

  it('fires when a whole file is pasted in a code block with no write', () => {
    const r = detectChatCodedFileWithoutWrite(bigHtml, []);
    expect(r?.path).toBe('index.html');
  });

  it('stays quiet when a successful write_file already landed this turn', () => {
    expect(
      detectChatCodedFileWithoutWrite(bigHtml, [{ name: 'write_file', success: true }]),
    ).toBeNull();
  });

  it('stays quiet on a short illustrative snippet (below the size floor)', () => {
    const snippet = 'Use this:\n```html\n<button>Go</button>\n```';
    expect(detectChatCodedFileWithoutWrite(snippet, [])).toBeNull();
  });

  it('stays quiet when there is no fenced code block at all', () => {
    expect(detectChatCodedFileWithoutWrite('I will update the file shortly.', [])).toBeNull();
  });

  it('picks the largest block when several are present', () => {
    const css = '```css\n.a{color:red}\n```';
    const r = detectChatCodedFileWithoutWrite(`${css}\n${bigHtml}`, []);
    expect(r?.path).toBe('index.html');
  });

  it('builds a nudge naming the path and write_file', () => {
    const nudge = buildChatCodedFileNudge('index.html');
    expect(nudge).toContain('`index.html`');
    expect(nudge).toContain('write_file');
    expect(nudge).toContain('never called');
  });
});

describe('detectProseDeliverableWithoutWrite (L3)', () => {
  const para = (s: string) => `${s} `.repeat(5);
  const report = [
    '# Quarterly Operations Review',
    '',
    '## Summary',
    para(
      'The team shipped three features this period and reduced the open-defect backlog while throughput improved across the board.',
    ),
    '',
    '## Findings',
    para(
      'Latency regressed on the read path before the caching fix landed, then recovered; error budgets held for every tier except one.',
    ),
    '',
    '## Recommendations',
    para(
      'Invest in the ingestion service, expand the integration suite, and formalize the release checklist for the next period.',
    ),
  ].join('\n');

  it('fires on a bare-markdown report with no write and infers a kebab path from the H1', () => {
    const r = detectProseDeliverableWithoutWrite(report, []);
    expect(r?.path).toBe('quarterly-operations-review.md');
  });

  it('prefers the caller-supplied expected-deliverable path when in scope', () => {
    const r = detectProseDeliverableWithoutWrite(report, [], 'reports/ops-review.md');
    expect(r?.path).toBe('reports/ops-review.md');
  });

  it('prefers the file the request named over a heading-derived guess', () => {
    const ask = 'Write the complete relocation plan as `plan.md` in this project workspace.';
    expect(detectProseDeliverableWithoutWrite(report, [], undefined, ask)?.path).toBe('plan.md');
    expect(
      detectProseDeliverableWithoutWrite(report, [], undefined, 'Save it to notes/summary.md.')
        ?.path,
    ).toBe('notes/summary.md');
    expect(detectProseDeliverableWithoutWrite(report, [], 'reports/ops-review.md', ask)?.path).toBe(
      'reports/ops-review.md',
    );
  });

  it('never redirects the write onto a file the request only reads', () => {
    const ask = 'Write a summary of `notes.md` for the team.';
    expect(detectProseDeliverableWithoutWrite(report, [], undefined, ask)?.path).toBe(
      'quarterly-operations-review.md',
    );
  });

  it('takes a filename the reply opened with when the request named none', () => {
    for (const opener of ['plan.md', '**plan.md**', '`plan.md`:']) {
      expect(detectProseDeliverableWithoutWrite(`${opener}\n${report}`, [])?.path).toBe('plan.md');
    }
  });

  it('fires on a text-fenced draft that opens with the file the request asked for', () => {
    // MiniCPM5 1B, 2026-09-28: no headings, 760 non-whitespace chars.
    const rows = Array.from(
      { length: 8 },
      (_, i) => `| T${i + 1} | task number ${i + 1} | Owner${i + 1} | No | reviewed |`,
    ).join('\n');
    const draft = [
      '```text',
      'plan.md',
      '---',
      'objective:',
      '- move the 18-person studio to Harbourview',
      '- floor plan, seating, meeting rooms, workshop corner',
      'assumptions:',
      '- full team roster, no external dependencies',
      'work plan:',
      '| ID | Task | Owner | Depends on | Done when |',
      rows,
      'risks:',
      '- vendor coordination and scheduling conflicts',
      '```',
    ].join('\n');
    const ask = 'Write the complete relocation plan as `plan.md` in this project workspace.';
    expect(detectProseDeliverableWithoutWrite(draft, [], undefined, ask)?.path).toBe('plan.md');
    expect(detectProseDeliverableWithoutWrite(draft, [], undefined, 'Plan the move.')).toBeNull();
    expect(
      detectProseDeliverableWithoutWrite(
        '```text\nplan.md\nobjective: move\n```',
        [],
        undefined,
        ask,
      ),
    ).toBeNull();
  });

  it('never unwraps a code fence into prose', () => {
    const code = `\`\`\`js\nplan.md\n${'const step = 1;\n'.repeat(80)}\`\`\``;
    const ask = 'Write the complete relocation plan as `plan.md`.';
    expect(detectProseDeliverableWithoutWrite(code, [], undefined, ask)).toBeNull();
  });

  it('falls back to report.md for a structured doc (>=2 headings) with no H1 title', () => {
    const noH1 = [
      '## Overview',
      para(
        'This section documents the operational context, the metrics observed, and the follow-up the team agreed to.',
      ),
      '## Detail',
      para(
        'This section expands on the specifics with enough concrete length to read as a genuine written document.',
      ),
    ].join('\n');
    expect(detectProseDeliverableWithoutWrite(noH1, [])?.path).toBe('report.md');
  });

  it('still fires when the report carries a small illustrative code block (prose dominates)', () => {
    const withSnippet = `${report}\n\n\`\`\`js\nconsole.log('example');\n\`\`\``;
    expect(detectProseDeliverableWithoutWrite(withSnippet, [])?.path).toBe(
      'quarterly-operations-review.md',
    );
  });

  it('stays quiet when a successful write_file landed this turn', () => {
    expect(
      detectProseDeliverableWithoutWrite(report, [{ name: 'write_file', success: true }]),
    ).toBeNull();
  });

  it('stays quiet when a successful write_artifact landed this turn', () => {
    expect(
      detectProseDeliverableWithoutWrite(report, [{ name: 'write_artifact', success: true }]),
    ).toBeNull();
  });

  it('stays quiet on a short structured reply (below the char floor)', () => {
    expect(
      detectProseDeliverableWithoutWrite('# Title\n\n## A\n\nToo short to be a report.', []),
    ).toBeNull();
  });

  it('stays quiet on long prose chatter with no document structure', () => {
    const chatter = 'I looked into this and here is what I think. '.repeat(30);
    expect(detectProseDeliverableWithoutWrite(chatter, [])).toBeNull();
  });

  it('stays quiet when the reply is dominated by a fenced code block (chat-coded detector owns it)', () => {
    const bigHtml = `Here's the page:\n\`\`\`html\n<!DOCTYPE html>\n<html><body>\n${'<div>row</div>\n'.repeat(80)}</body></html>\n\`\`\``;
    expect(detectProseDeliverableWithoutWrite(bigHtml, [])).toBeNull();
  });

  it('builds a nudge naming the inferred path and a write tool', () => {
    const nudge = buildProseDeliverableNudge('report.md');
    expect(nudge).toContain('report.md');
    expect(nudge).toContain('write_file');
    expect(nudge).toContain('write tool');
  });
});
