import { describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { generateProjectAboutFromRepo } from './project-generator.js';

/**
 * The generator only needs `oneShotCompletion` from the manager — we
 * stub that single method rather than spinning up the full ChatManager
 * with providers and disk state.
 */

function makeManager(response: string): ChatManager {
  return {
    oneShotCompletion: vi.fn().mockResolvedValue(response),
  } as unknown as ChatManager;
}

describe('generateProjectAboutFromRepo', () => {
  it('parses the about and mission objectives sections', async () => {
    const manager = makeManager(
      [
        'About paragraph one — this project does foo for bar. It serves the team that needs to do baz on a regular basis.',
        '',
        'About paragraph two with more substantive context about the scope and intent.',
        '',
        '---MISSION_OBJECTIVES---',
        '',
        '- Ship a working prototype within four weeks.',
        '- Cover at least three primary workflows end-to-end.',
        '- Match the existing platform style guide.',
      ].join('\n'),
    );
    const result = await generateProjectAboutFromRepo(manager, {
      name: 'demo-project',
      repoUrl: 'https://github.com/o/demo-project',
      readme: '# Demo\nThis is the readme.',
    });
    expect(result.about).toMatch(/About paragraph one/);
    expect(result.about).not.toMatch(/MISSION_OBJECTIVES/);
    expect(result.missionObjectives).toMatch(/Ship a working prototype/);
  });

  it('falls back to a placeholder when the model omits the delimiter', async () => {
    const manager = makeManager('Some random response without the delimiter.');
    const result = await generateProjectAboutFromRepo(manager, {
      name: 'demo-project',
      repoUrl: 'https://github.com/o/demo-project',
      readme: '',
    });
    expect(result.about.length).toBeGreaterThanOrEqual(60);
    expect(result.missionObjectives.length).toBeGreaterThanOrEqual(40);
    // Fallback always references the URL so the user knows which repo
    // it was sourced from when they edit it down.
    expect(result.about).toContain('https://github.com/o/demo-project');
  });

  it("falls back when the about section is too short to satisfy the schema's min", async () => {
    const manager = makeManager(['Short.', '---MISSION_OBJECTIVES---', '- bullet one.'].join('\n'));
    const result = await generateProjectAboutFromRepo(manager, {
      name: 'tiny',
      repoUrl: 'https://github.com/o/tiny',
      readme: '',
    });
    expect(result.about.length).toBeGreaterThanOrEqual(60);
    expect(result.missionObjectives.length).toBeGreaterThanOrEqual(40);
  });

  it('strips a wrapping markdown fence if the model adds one', async () => {
    const manager = makeManager(
      [
        '```markdown',
        'About text that is plenty long enough to satisfy the minimum length rule the schema enforces.',
        '',
        '---MISSION_OBJECTIVES---',
        '',
        '- Concrete bullet that exceeds forty characters in length easily.',
        '```',
      ].join('\n'),
    );
    const result = await generateProjectAboutFromRepo(manager, {
      name: 'fence',
      repoUrl: 'https://github.com/o/fence',
      readme: '',
    });
    expect(result.about).not.toMatch(/```/);
    expect(result.missionObjectives).not.toMatch(/```/);
  });
});
