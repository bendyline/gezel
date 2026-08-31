import { describe, expect, it } from 'vitest';
import {
  CODING_PROJECT_TYPE_IDS,
  PROJECT_TYPES,
  ProjectTypeSchema,
  getProjectType,
  isCodingProject,
} from './taxonomy.js';

describe('project type gezel-role affinity', () => {
  it('keeps every taxonomy entry valid with disjoint role tiers', () => {
    for (const projectType of PROJECT_TYPES) {
      expect(ProjectTypeSchema.parse(projectType)).toEqual(projectType);

      const defaults = projectType.gezelRoles.default.map((role) => role.templateId);
      const suggested = projectType.gezelRoles.suggested.map((role) => role.templateId);
      expect(new Set(defaults).size).toBe(defaults.length);
      expect(new Set(suggested).size).toBe(suggested.length);
      expect(defaults.filter((templateId) => suggested.includes(templateId))).toEqual([]);
    }
  });

  it('recommends a builder-led crew and security specialist for code projects', () => {
    for (const typeId of ['web-app', 'api-service', 'cli-tool', 'library']) {
      const projectType = getProjectType(typeId);
      expect(projectType?.gezelRoles.default.map((role) => role.templateId)).toContain('builder');
      expect(projectType?.gezelRoles.suggested.map((role) => role.templateId)).toContain(
        'veiligheidsmeester',
      );
    }
  });
});

describe('isCodingProject', () => {
  it('classifies every coding id and only ids that exist in the taxonomy', () => {
    for (const id of CODING_PROJECT_TYPE_IDS) {
      expect(getProjectType(id), `unknown taxonomy id ${id}`).toBeDefined();
      expect(isCodingProject({ projectTypeId: id })).toBe(true);
    }
  });

  it('rejects non-coding types and unclassified projects', () => {
    expect(isCodingProject({ projectTypeId: 'content-writing' })).toBe(false);
    expect(isCodingProject({ detectedProjectType: { id: 'media-production' } })).toBe(false);
    expect(isCodingProject({})).toBe(false);
  });

  it('resolves the explicit override ahead of detection, both ways', () => {
    expect(
      isCodingProject({
        projectTypeId: 'content-writing',
        detectedProjectType: { id: 'web-app' },
      }),
    ).toBe(false);
    expect(
      isCodingProject({
        projectTypeId: 'web-app',
        detectedProjectType: { id: 'content-writing' },
      }),
    ).toBe(true);
  });

  it('honours detection when there is no override', () => {
    expect(isCodingProject({ detectedProjectType: { id: 'cli-tool' } })).toBe(true);
  });
});
