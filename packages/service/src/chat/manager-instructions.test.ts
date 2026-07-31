import type { ProjectDetail } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type BuildInstructionsOptions, buildInstructions } from './manager.js';

function promptWithTools(names: string[]): string {
  return buildInstructions({
    name: 'Tomas',
    role: 'Meester',
    about: 'Route work to the right specialist.',
    executionDensity: 'flat',
    availableTools: names.map((name) => ({ name, description: `${name} tool` })),
  } as unknown as BuildInstructionsOptions).full;
}

describe('buildInstructions coordinator routing', () => {
  it('never coaches a coordinator to call unavailable start tools', () => {
    const prompt = promptWithTools(['ensure_gezel', 'message_gezel', 'create_task']);
    expect(prompt).toContain('`message_gezel`');
    expect(prompt).not.toContain('`start_job({');
    expect(prompt).not.toContain('`start_project({');
  });

  it('routes named binary formats through craftbooks without permitting markdown substitution', () => {
    const prompt = promptWithTools([
      'start_job',
      'suggest_craftbook',
      'invoke_craftbook',
      'convert_document',
      'preview_document',
      'save_artifact',
    ]);
    expect(prompt).toContain('first call `suggest_craftbook`');
    expect(prompt).toContain('PowerPoint/PPTX');
    expect(prompt).toContain('Word/DOCX');
    expect(prompt).toContain('MP4, GIF');
    expect(prompt).toContain('do not silently substitute markdown');
    expect(prompt).toContain('author Markdown');
    expect(prompt).toContain('Do not recruit a developer');
    expect(prompt).toContain('`convert_document`');
    expect(prompt).toContain('`save_artifact`');
  });
});

describe('buildInstructions assigned pronouns', () => {
  const soloProject = {
    id: 'solo-job',
    name: 'Solo job',
    mode: 'solo',
  } as unknown as ProjectDetail;

  it.each([
    ['male', 'he/him', 'he will handle the entire project himself'],
    ['female', 'she/her', 'she will handle the entire project herself'],
    ['non-binary', 'they/them', 'they will handle the entire project themselves'],
  ] as const)('uses %s voorman pronouns in solo-project context', (gender, label, sentence) => {
    const { full } = buildInstructions({
      name: 'Worker',
      about: 'A worker.',
      project: soloProject,
      voormanName: 'Lyudmyla',
      voormanGender: gender,
    });

    expect(full).toContain(`Lyudmyla** (${label})`);
    expect(full).toContain(sentence);
  });
});
