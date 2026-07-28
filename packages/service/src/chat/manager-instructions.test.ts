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
    expect(prompt).toContain('do not silently substitute markdown');
    expect(prompt).toContain('`convert_document`');
    expect(prompt).toContain('`save_artifact`');
  });
});
