import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSkillDoc } from './skill-doc.js';

const FIXTURES = fileURLToPath(new URL('./__fixtures__', import.meta.url));
const read = (rel: string) => readFileSync(join(FIXTURES, rel), 'utf8');

describe('parseSkillDoc', () => {
  it('parses the careful fixture: frontmatter, flattened hooks, preamble strip, telemetry drop', () => {
    const doc = parseSkillDoc(read('gstack/careful/SKILL.md'), { fallbackName: 'careful' });
    expect(doc.name).toBe('careful');
    expect(doc.version).toBe('0.1.0');
    expect(doc.triggers).toEqual(['be careful', 'warn before destructive', 'safety mode']);
    expect(doc.allowedTools).toEqual(['Bash', 'Read']);
    expect(doc.hooks).toEqual([
      {
        phase: 'PreToolUse',
        matcher: 'Bash',
        command: 'bash $HOME/.claude/skills/gstack/careful/bin/check-careful.sh',
        statusMessage: 'Checking for destructive commands...',
      },
    ]);
    expect(doc.generated).toBe(true);
    expect(doc.title).toBe('/careful — Destructive Command Guardrails');
    expect(doc.whenToInvoke).toContain('Warns before rm -rf');
    // Body starts at the H1 and the injected telemetry fence is gone.
    expect(doc.body.startsWith('# /careful')).toBe(true);
    expect(doc.body).not.toContain('skill-usage.jsonl');
    expect(doc.body).toContain("## What's protected");
    // The raw body (hash basis) still carries everything.
    expect(doc.rawBody).toContain('skill-usage.jsonl');
    expect(doc.rawBody).toContain('AUTO-GENERATED');
  });

  it('parses office-hours: big preamble stripped, extra frontmatter preserved', () => {
    const doc = parseSkillDoc(read('gstack/office-hours/SKILL.md'), {
      fallbackName: 'office-hours',
    });
    expect(doc.title).toBe('YC Office Hours');
    expect(doc.body.startsWith('# YC Office Hours')).toBe(true);
    // The host-integration preamble must be gone entirely (GSTACK_HEADLESS
    // is the host env toggle referenced only in injected preamble blocks).
    expect(doc.body).not.toContain('GSTACK_HEADLESS');
    expect(doc.body.length).toBeLessThan(doc.rawBody.length / 2);
    expect(Object.keys(doc.extraFrontmatter).sort()).toEqual(['gbrain', 'preamble-tier']);
  });

  it('leaves hand-authored (non-generated) skills untouched', () => {
    const raw = read('claude/minimal/SKILL.md');
    const doc = parseSkillDoc(raw, { fallbackName: 'minimal' });
    expect(doc.generated).toBe(false);
    expect(doc.name).toBe('tidy-notes');
    expect(doc.title).toBe('Tidy Notes');
    expect(doc.body).toContain('# Tidy Notes');
    expect(doc.body).toContain('## Style');
  });

  it('degrades gracefully on broken YAML frontmatter', () => {
    const doc = parseSkillDoc('---\nname: [unclosed\n---\n\n# T\n\nbody', {
      fallbackName: 'fallback',
    });
    expect(doc.name).toBe('fallback');
    expect(doc.body).toContain('body');
  });

  it('sorts companion files deterministically', () => {
    const doc = parseSkillDoc('# X\n\nbody', {
      fallbackName: 'x',
      files: [
        { relPath: 'sections/z.md', kind: 'section', bytes: 10 },
        { relPath: 'bin/a.sh', kind: 'bin', bytes: 5 },
      ],
    });
    expect(doc.files.map((f) => f.relPath)).toEqual(['bin/a.sh', 'sections/z.md']);
  });
});
