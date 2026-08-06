import { describe, expect, it } from 'vitest';
import {
  buildKickoffStepDescription,
  buildKickoffTaskDescription,
  inferSourceDeliverablePath,
  macroLooksLikeBuildMission,
  shouldPromoteStartJobToProject,
} from './kickoff-text.js';

const BUILD_BRIEF = {
  name: 'Snake Game',
  about: 'A tiny browser game for the user to play with.',
  missionObjectives: 'A playable snake game at index.html.',
};

const NON_BUILD_BRIEF = {
  name: 'Reading list',
  about: 'Curate a reading list from my notes.',
  missionObjectives: 'A well-organized list.',
};

describe('buildKickoffTaskDescription', () => {
  it('build missions get the deliverable guard', () => {
    const text = buildKickoffTaskDescription(BUILD_BRIEF);
    expect(text).toContain('planning is not the deliverable');
    expect(text).toContain('write_file({ path: "index.html"');
  });

  it('non-build missions stay plain', () => {
    const text = buildKickoffTaskDescription(NON_BUILD_BRIEF);
    expect(text).not.toContain('planning is not the deliverable');
  });

  it('kickoffNote folds in as a meester note on both paths', () => {
    const withGuard = buildKickoffTaskDescription({
      ...BUILD_BRIEF,
      kickoffNote: 'Keep the palette green.',
    });
    expect(withGuard).toContain('Note from the meester: Keep the palette green.');
    expect(withGuard).toContain('planning is not the deliverable');

    const plain = buildKickoffTaskDescription({
      ...NON_BUILD_BRIEF,
      kickoffNote: 'Group by theme.',
    });
    expect(plain).toContain('Note from the meester: Group by theme.');
  });

  it('image-needing builds carry the full delegation recipe (migrated from the old notify)', () => {
    const text = buildKickoffTaskDescription({
      name: 'Pet Shop',
      about: 'A pet shop website with a generated logo.',
      missionObjectives: 'Site at index.html plus assets/logo.png.',
    });
    expect(text).toContain('ensure_gezel for an image-generator');
    expect(text).toContain('generate_image({ prompt, saveAs: "assets/logo.png" })');
    expect(text).toContain('<img src="assets/logo.png">');
    expect(text).toContain('do not create a separate logo/image project');
  });
});

describe('buildKickoffStepDescription', () => {
  it('crew build steps carry the file-handoff delegation steering', () => {
    const crew = buildKickoffStepDescription(BUILD_BRIEF, { isCrew: true });
    expect(crew).toContain('expectedDeliverable: { kind: "file", filePath: "index.html" }');
    expect(crew).toContain('do not ask a Designer to paste HTML/CSS in chat');
  });

  it('solo build steps keep the shippable-file steer without delegation talk', () => {
    const solo = buildKickoffStepDescription(BUILD_BRIEF);
    expect(solo).toContain('first shippable workspace file');
    expect(solo).not.toContain('ensure_gezel');
  });

  it('non-build steps get the plain first-move steer', () => {
    expect(buildKickoffStepDescription(NON_BUILD_BRIEF, { isCrew: true })).toContain(
      'first concrete move',
    );
  });
});

describe('inferSourceDeliverablePath', () => {
  it('an explicitly named file wins regardless of keywords', () => {
    expect(
      inferSourceDeliverablePath({
        name: 'Event pipeline',
        about: 'A TypeScript event pipeline delivering src/types.ts.',
        missionObjectives: 'Typed producer/consumer.',
      }),
    ).toBe('src/types.ts');
  });

  it('preserves an explicitly named raster path for capability routing', () => {
    expect(
      inferSourceDeliverablePath({
        name: 'Campaign poster',
        about: 'Render one finished visual at assets/poster.webp.',
        missionObjectives: 'The requested image exists in the project workspace.',
      }),
    ).toBe('assets/poster.webp');
  });

  it('preserves an explicitly named PPTX path for craftbook routing', () => {
    expect(
      inferSourceDeliverablePath({
        name: 'Battle of the Marne presentation',
        about: 'Prepare an accessible history presentation for a general audience.',
        missionObjectives: 'Publish artifacts/marne-battle.pptx.',
      }),
    ).toBe('artifacts/marne-battle.pptx');
  });

  it('build missions without a named file default to index.html; non-builds to undefined', () => {
    expect(inferSourceDeliverablePath(BUILD_BRIEF)).toBe('index.html');
    expect(
      inferSourceDeliverablePath({
        name: 'Quarterly review',
        about: 'Summarize the quarter.',
        missionObjectives: 'A crisp summary.',
      }),
    ).toBeUndefined();
  });
});

describe('promotion + mission predicates', () => {
  it('image-needing builds promote; plain builds and non-builds do not', () => {
    expect(
      shouldPromoteStartJobToProject({
        name: 'Pet Shop',
        about: 'Website with a generated logo.',
        missionObjectives: 'index.html + logo.png',
      }),
    ).toBe(true);
    expect(shouldPromoteStartJobToProject(BUILD_BRIEF)).toBe(false);
    expect(macroLooksLikeBuildMission('Notes', 'Organize notes', 'Tidy list')).toBe(false);
  });
});
