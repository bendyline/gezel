import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOLSET_GROUPS,
  MODEL_TIER_ORDER,
  ROLES,
  type RoleId,
  meetsCapabilityFloor,
  resolveRoleId,
  roleCapabilityFloor,
  roleDefaultBooks,
  roleDeliverableScripts,
  roleGateAffinity,
  roleSuggestedTuningProfile,
  tierAtLeast,
  tierRank,
  toolsetGroupsForRole,
} from './index.js';

describe('role registry — resolution', () => {
  it('resolves exact canonical ids', () => {
    expect(resolveRoleId('researcher')).toBe('researcher');
    expect(resolveRoleId('Web-Developer')).toBe('web-developer');
    expect(resolveRoleId('  Planner ')).toBe('planner');
  });

  it('resolves aliases, web-flavored before generic developer', () => {
    expect(resolveRoleId('Backend Engineer')).toBe('developer');
    expect(resolveRoleId('Builder')).toBe('developer');
    expect(resolveRoleId('Full Stack Developer')).toBe('web-developer');
    expect(resolveRoleId('Frontend dev')).toBe('web-developer');
    expect(resolveRoleId('Research Analyst')).toBe('researcher');
    expect(resolveRoleId('Foreman')).toBe('voorman');
    expect(resolveRoleId('Loopbaancoach')).toBe('voorman');
    expect(resolveRoleId('Fitness Coach')).toBe('voorman');
    expect(resolveRoleId('Visual Designer')).toBe('designer');
    expect(resolveRoleId('AI Image Generation Specialist')).toBe('image-generator');
    // Dutch craft roles shipped as craftbook suggestedRoles — the designer
    // kit carries the `images` group their steps depend on.
    expect(resolveRoleId('Tekenaar')).toBe('designer');
    expect(resolveRoleId('Assetsmid')).toBe('designer');
    expect(resolveRoleId('Verhalenverteller')).toBe('copywriter');
  });

  it('returns null for unknown roles and undefined', () => {
    expect(resolveRoleId('Astronaut')).toBeNull();
    expect(resolveRoleId(undefined)).toBeNull();
    expect(resolveRoleId('')).toBeNull();
  });
});

describe('role registry — facet accessors', () => {
  it('toolsetGroups: known role returns its kit, unknown falls back to default', () => {
    expect(toolsetGroupsForRole('researcher')).toBe(ROLES.researcher.toolsetGroups);
    expect(toolsetGroupsForRole('Astronaut')).toBe(DEFAULT_TOOLSET_GROUPS);
  });

  it('suggestedTuningProfile mirrors the role bundle', () => {
    expect(roleSuggestedTuningProfile('developer')).toBe('thinking-coding');
    expect(roleSuggestedTuningProfile('researcher')).toBe('thinking-general');
    expect(roleSuggestedTuningProfile('image-generator')).toBeUndefined();
  });

  it('gateAffinity: researcher defaults to citation + grounding', () => {
    const names = roleGateAffinity('researcher').map((r) => r.name);
    expect(names).toContain('checkCitationsResolve');
    expect(names).toContain('checkValueGrounding');
    expect(roleGateAffinity('copywriter').map((r) => r.name)).toEqual([
      'checkWordBand',
      'checkReadingLevel',
    ]);
    expect(roleGateAffinity('meester')).toEqual([]);
    expect(roleGateAffinity('Astronaut')).toEqual([]);
  });

  it('defaultBooks are present for delivering roles', () => {
    expect(roleDefaultBooks('researcher')).toContain('research-report');
    expect(roleDefaultBooks('developer')).toContain('build-loop');
    expect(roleDefaultBooks('Astronaut')).toEqual([]);
  });

  it('roleDeliverableScripts binds the deliverable file into each affinity script', () => {
    const scripts = roleDeliverableScripts('researcher', 'brief.md');
    expect(scripts.map((s) => s.name)).toEqual(['checkCitationsResolve', 'checkValueGrounding']);
    for (const s of scripts) {
      expect(s.scope).toBe('standard');
      expect(s.inputs).toMatchObject({ file: 'brief.md' });
    }
    expect(roleDeliverableScripts('meester', 'x.md')).toEqual([]);
    expect(roleDeliverableScripts('Astronaut', 'x.md')).toEqual([]);
  });
});

describe('role registry — capability floor', () => {
  it('tier ordering is monotonic', () => {
    expect(tierRank('tiny')).toBe(0);
    expect(tierAtLeast('medium', 'small')).toBe(true);
    expect(tierAtLeast('small', 'medium')).toBe(false);
    expect(tierAtLeast('cloud', 'large')).toBe(true);
  });

  it('meetsCapabilityFloor gates by role floor', () => {
    expect(roleCapabilityFloor('developer')).toBe('small');
    expect(meetsCapabilityFloor('tiny', 'developer')).toBe(false);
    expect(meetsCapabilityFloor('small', 'developer')).toBe(true);
    expect(meetsCapabilityFloor('small', 'meester')).toBe(false); // floor medium
    expect(meetsCapabilityFloor('cloud', 'researcher')).toBe(true);
    // unknown role never blocks
    expect(meetsCapabilityFloor('tiny', 'Astronaut')).toBe(true);
    expect(roleCapabilityFloor('Astronaut')).toBeNull();
  });
});

describe('role registry — invariants', () => {
  const ids = Object.keys(ROLES) as RoleId[];

  it('every role is internally consistent', () => {
    for (const id of ids) {
      const def = ROLES[id];
      expect(def.id, `${id}.id`).toBe(id);
      expect(def.toolsetGroups.length, `${id}.toolsetGroups`).toBeGreaterThan(0);
      expect(MODEL_TIER_ORDER, `${id}.capabilityFloor`).toContain(def.capabilityFloor);
      // gateAffinity is the standard-scope vocabulary
      for (const ref of def.gateAffinity) {
        expect(ref.scope, `${id} gate ${ref.name}`).toBe('standard');
        expect(ref.name.startsWith('check'), `${id} gate ${ref.name}`).toBe(true);
      }
      // defaultBooks are unique kebab-case ids
      const books = def.defaultBooks;
      expect(new Set(books).size, `${id} defaultBooks unique`).toBe(books.length);
      for (const b of books) expect(b, `${id} book "${b}"`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
