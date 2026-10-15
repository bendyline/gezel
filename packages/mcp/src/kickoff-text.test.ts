import { describe, expect, it } from 'vitest';
import {
  briefIsWrittenWork,
  buildKickoffStepDescription,
  buildKickoffTaskDescription,
  buildTypedKickoffStep,
  defaultDeliverableForBrief,
  documentDeliverablePath,
  documentProducerRole,
  inferSourceDeliverablePath,
  kickoffTaskTitle,
  macroLooksLikeBuildMission,
  shouldPromoteStartJobToProject,
  typedKickoffWatch,
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

// Every goal used to default to index.html: a family trip was handed to a
// Developer as a web page.
describe('a goal with nothing to build', () => {
  const TRIP = {
    name: 'Family trip to Portugal',
    about: 'Ten days in Lisbon and the Algarve with two kids.',
    missionObjectives: '- A day-by-day plan\n- A packing list',
  };

  it('is written up as a document named after it, by the role that writes it', () => {
    expect(briefIsWrittenWork(TRIP)).toBe(true);
    expect(defaultDeliverableForBrief(TRIP)).toEqual({
      path: 'family-trip-to-portugal.md',
      document: true,
    });
    expect(documentProducerRole(`${TRIP.name} ${TRIP.about}`)).toBe('planner');
    expect(documentProducerRole('Research which heat pumps suit an old house')).toBe('researcher');
    expect(documentProducerRole('A thank-you note for our neighbours')).toBe('copywriter');
    expect(kickoffTaskTitle(TRIP)).toBe('Family trip to Portugal');
  });

  it('keeps the build kickoff for a build, or for a brief with a making verb', () => {
    expect(defaultDeliverableForBrief(BUILD_BRIEF)).toEqual({
      path: 'index.html',
      document: false,
    });
    expect(kickoffTaskTitle(BUILD_BRIEF)).toBe('Build Snake Game');
    const verb = { ...TRIP, about: 'Build the requested small deliverable.' };
    expect(briefIsWrittenWork(verb)).toBe(false);
    // Making work that names no file and is not a browser build has nothing
    // to gate on; an index.html gate would never pass.
    expect(defaultDeliverableForBrief(verb)).toBeNull();
    expect(
      defaultDeliverableForBrief({
        name: 'Backup Script Repair',
        about: 'Fix the bug in my nightly backup script.',
        missionObjectives: '- The backup copies every folder',
      }),
    ).toBeNull();
  });

  it('names the document plainly, whatever the characters', () => {
    expect(documentDeliverablePath('Café Crème: Menu Ideas!')).toBe('cafe-creme-menu-ideas.md');
    expect(documentDeliverablePath('—')).toBe('plan.md');
  });
});

describe('buildTypedKickoffStep', () => {
  it('points the lead at the Output page and asks for what the brief left unsaid', () => {
    const step = buildTypedKickoffStep({
      typeName: 'Trip Planner',
      brief: { name: 'Kyoto', about: 'A week in Kyoto in the spring.' },
      dataFile: 'trip.json',
      unsaid: ['Departure date'],
    });
    expect(step.name).toBe('First draft');
    expect(step.description).toContain('You lead this Trip Planner project');
    expect(step.description).toContain('`trip.json`');
    expect(step.description).toContain('"Departure date"');
    expect(step.description).not.toContain('index.html');
  });

  // Day one of a seven-day trip, then "shall I go on?", was reported as done.
  it('asks for the whole first version before any question', () => {
    const step = buildTypedKickoffStep({
      typeName: 'Trip Planner',
      brief: { name: 'Lisbon', about: 'A week in Lisbon.' },
      dataFile: 'trip.json',
      unsaid: [],
    });
    expect(step.description).toContain('make the whole first version there');
    expect(step.description).toContain('each day of a trip');
    expect(step.description).toContain('finish it before you ask anything');
    expect(step.description).not.toContain('has something in it');
  });

  // The meester's own brief for a Lisbon trip added hotels, dining and a
  // budget the default posture could not research (2026-10-11).
  it('states the goal in the person’s words, and leaves extras for the lead to offer', () => {
    const step = buildTypedKickoffStep({
      typeName: 'Trip Planner',
      brief: {
        name: 'Lisbon Trip Planning',
        about: 'Plan a week in Lisbon. Include hotels, dining recommendations and a budget.',
      },
      request: 'Plan a trip to Lisbon next spring for the four of us, about a week.',
      unsaid: [],
    });
    expect(step.description).toContain(
      'Their goal: Plan a trip to Lisbon next spring for the four of us, about a week.',
    );
    expect(step.description).not.toContain('budget');
    expect(step.description).toContain('offer it in your reply instead of adding it');
  });

  // A Reisleider re-recorded Lisbon and four people, made up a date for
  // "next spring", and planned no days (2026-10-12).
  it('names what the request already recorded so the lead starts on the plan', () => {
    const step = buildTypedKickoffStep({
      typeName: 'Trip Planner',
      brief: { name: 'Lisbon', about: 'A week in Lisbon.' },
      dataFile: 'trip.json',
      unsaid: [],
      known: [
        { title: 'Where to?', value: 'Lisbon' },
        { title: 'Departure date', value: 'next spring' },
        { title: "Who's going?", value: '4' },
      ],
    });
    expect(step.description).toContain(
      'Already recorded from their words: "Where to?" Lisbon, "Departure date" next spring, "Who\'s going?" 4.',
    );
    expect(step.description).toContain('Start on the plan itself');
  });
});

describe('typedKickoffWatch', () => {
  it('watches every data file the Output page reads', () => {
    // A Job Hunt lead that logged "interview at Northwind next month" grew
    // activity.json, which the page shows, while only pipeline.json counted.
    expect(
      typedKickoffWatch({
        pages: {
          reads: [
            { source: 'workspace', path: 'pipeline.json' },
            { source: 'workspace', path: 'activity.json' },
          ],
        },
      }),
    ).toEqual(['pipeline.json', 'activity.json']);
  });

  it('watches the seeded index of a folder the page reads', () => {
    expect(
      typedKickoffWatch({
        pages: {
          reads: [
            { source: 'workspace', path: 'posts', subtree: true },
            { source: 'workspace', path: 'voice-guide.md' },
            { source: 'artifacts', path: 'data', subtree: true },
          ],
        },
        workspaceSeed: ['voice-guide.md', 'posts/index.json'],
      }),
    ).toEqual(['posts/index.json']);
  });

  it('watches nothing for a page with no workspace data', () => {
    expect(
      typedKickoffWatch({ pages: { reads: [{ source: 'artifacts', path: 'notes' }] } }),
    ).toEqual([]);
  });
});
