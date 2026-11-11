import { describe, expect, it } from 'vitest';
import {
  crewLeadLabel,
  crewLeadLabelLower,
  mainCrewMemberSubtitle,
  speaksAsMainCrewMember,
} from './labels.js';

describe("a project's main crew member", () => {
  it('is a crew lead only where there is a crew to lead', () => {
    expect(crewLeadLabel({})).toBe('Crew Lead');
    expect(crewLeadLabel({ mode: 'crew' })).toBe('Crew Lead');
    expect(crewLeadLabel({ mode: 'solo' })).toBe('Main crew member');
    expect(crewLeadLabelLower({ mode: 'solo' })).toBe('main crew member');
    // A project type's own title wins in either shape.
    expect(crewLeadLabel({ mode: 'solo', leadLabel: 'Opponent' })).toBe('Opponent');
  });

  // "builder" sat under a Writer's name on a solo document project.
  it('keeps their own role under their name when they work alone', () => {
    expect(mainCrewMemberSubtitle({ mode: 'solo' }, 'Writer')).toBe('Writer');
    expect(mainCrewMemberSubtitle({ mode: 'solo' }, 'Klerk')).toBe('Scribe');
    expect(mainCrewMemberSubtitle({ mode: 'solo' }, undefined)).toBe('main crew member');
    expect(mainCrewMemberSubtitle({ mode: 'crew' }, 'Reviewer')).toBe('crew lead');
    expect(mainCrewMemberSubtitle({ mode: 'solo', leadLabel: 'Coach' }, 'Tutor')).toBe('coach');
  });

  it('carries the star in the project they are assigned to, whatever their role', () => {
    const project = { voormanGezelId: 'minji' };
    expect(speaksAsMainCrewMember(project, 'minji', 'Builder')).toBe(true);
    expect(speaksAsMainCrewMember(project, 'dejan', 'Voorman')).toBe(false);
    expect(speaksAsMainCrewMember({}, 'dejan', 'Crew Lead')).toBe(false);
    // Before the project is known, a crew lead's role stands in.
    expect(speaksAsMainCrewMember(undefined, 'dejan', 'Crew Lead')).toBe(true);
    expect(speaksAsMainCrewMember(undefined, 'minji', 'Builder')).toBe(false);
  });
});
