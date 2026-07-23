import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverWorkspaceSkills, parseSkillFile } from './skill-scanner.js';

describe('parseSkillFile', () => {
  it('parses a minimal SKILL.md with frontmatter + body', () => {
    const raw = `---
name: my-skill
description: A test skill
---

# Skill body

Some prose here.
`;
    const parsed = parseSkillFile(raw, 'fallback');
    expect(parsed.name).toBe('my-skill');
    expect(parsed.description).toBe('A test skill');
    expect(parsed.body).toContain('# Skill body');
    expect(parsed.hasShellScripts).toBe(false);
  });

  it('falls back to the directory name when frontmatter is missing', () => {
    const raw = '# Just a body\n\nprose';
    const parsed = parseSkillFile(raw, 'dir-name');
    expect(parsed.name).toBe('dir-name');
    expect(parsed.description).toBeUndefined();
  });

  it('parses triggers as an array', () => {
    const raw = `---
name: review
triggers:
  - review this pr
  - check my diff
---

body
`;
    const parsed = parseSkillFile(raw, 'review');
    expect(parsed.triggers).toEqual(['review this pr', 'check my diff']);
  });

  it('parses block-scalar description (|)', () => {
    const raw = `---
name: ship
description: |
  Multi-line
  description here.
---

body
`;
    const parsed = parseSkillFile(raw, 'ship');
    expect(parsed.description).toBe('Multi-line\ndescription here.');
  });

  it('flags shell scripts in the body', () => {
    const raw = `---
name: gstack
---

\`\`\`bash
echo hi
\`\`\`
`;
    const parsed = parseSkillFile(raw, 'gstack');
    expect(parsed.hasShellScripts).toBe(true);
  });

  it('strips quoted values', () => {
    const raw = `---
name: "my skill"
description: 'with quotes'
---

body
`;
    const parsed = parseSkillFile(raw, 'fallback');
    expect(parsed.name).toBe('my skill');
    expect(parsed.description).toBe('with quotes');
  });
});

describe('discoverWorkspaceSkills', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-skills-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty list when no skill folders exist', async () => {
    const result = await discoverWorkspaceSkills(dir);
    expect(result).toEqual([]);
  });

  it('discovers skills under .claude/skills', async () => {
    await mkdir(join(dir, '.claude', 'skills', 'review'), { recursive: true });
    await writeFile(
      join(dir, '.claude', 'skills', 'review', 'SKILL.md'),
      `---
name: review
description: PR review
---

Body.
`,
    );
    const result = await discoverWorkspaceSkills(dir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('review');
    expect(result[0]!.origin).toBe('claude');
    expect(result[0]!.description).toBe('PR review');
  });

  it('discovers skills across all three origins', async () => {
    await mkdir(join(dir, '.claude', 'skills', 'a'), { recursive: true });
    await writeFile(join(dir, '.claude', 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\n');
    await mkdir(join(dir, '.gstack', 'skills', 'b'), { recursive: true });
    await writeFile(join(dir, '.gstack', 'skills', 'b', 'SKILL.md'), '---\nname: b\n---\n');
    await mkdir(join(dir, 'agents', 'skills', 'c'), { recursive: true });
    await writeFile(join(dir, 'agents', 'skills', 'c', 'SKILL.md'), '---\nname: c\n---\n');
    const result = await discoverWorkspaceSkills(dir);
    expect(result.map((s) => s.name)).toEqual(['a', 'b', 'c']);
    expect(result.map((s) => s.origin)).toEqual(['claude', 'gstack', 'agents']);
  });

  it('skips directories without a SKILL.md', async () => {
    await mkdir(join(dir, '.claude', 'skills', 'no-skill-here'), { recursive: true });
    await writeFile(join(dir, '.claude', 'skills', 'no-skill-here', 'README.md'), 'not a skill');
    const result = await discoverWorkspaceSkills(dir);
    expect(result).toEqual([]);
  });
});
