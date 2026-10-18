import { describe, expect, it } from 'vitest';
import {
  type BriefRoutableType,
  briefAsksForBuild,
  fillProjectTypeParams,
  matchProjectTypeForBrief,
  projectTypeNamedByBrief,
  projectTypesMentionedByBrief,
} from './brief-route.js';

const lead = (templateId: string) => [{ templateId, voorman: true }];

/** A slice of the gilde catalog, tags as shipped. */
const TYPES: BriefRoutableType[] = [
  {
    id: 'trip-planner',
    name: 'Trip Planner',
    tags: ['travel', 'trip', 'itinerary', 'packing', 'journal'],
    gezels: lead('reisleider'),
    pages: { reads: [{ source: 'workspace', path: 'trip.json' }] },
    params: {
      properties: {
        destination: { type: 'string', title: 'Where to?', default: 'somewhere wonderful' },
        start: { type: 'string', title: 'Departure date', default: '2026-12-01' },
        travellers: { type: 'string', title: "Who's going?", default: '' },
      },
      required: ['destination', 'start'],
    },
  },
  {
    id: 'event-planner',
    name: 'Event Planner',
    tags: ['event', 'wedding', 'party', 'guests', 'planning'],
    gezels: lead('ceremoniemeester'),
    pages: { reads: [{ source: 'workspace', path: 'guests.json' }] },
    params: {
      properties: {
        occasion: { type: 'string', title: 'What are we celebrating?' },
        date: { type: 'string', title: 'When is it?', default: '2026-12-31' },
      },
      required: ['occasion', 'date'],
    },
  },
  {
    id: 'caregiving-binder',
    name: 'Caregiving Binder',
    tags: ['caregiving', 'health', 'family', 'medications', 'appointments'],
    gezels: lead('zorgcoordinator'),
    params: {
      properties: { person: { type: 'string', title: 'Who is the care for?', default: 'Mom' } },
      required: ['person'],
    },
  },
  {
    id: 'life-binder',
    name: 'Life Binder',
    tags: ['estate', 'documents', 'emergency', 'family', 'insurance'],
    gezels: lead('archivaris'),
    params: {
      properties: { household: { type: 'string', title: 'Who is this binder for?' } },
      required: ['household'],
    },
  },
  {
    id: 'language-trainer',
    name: 'Language Trainer',
    tags: ['language', 'learning', 'tutor', 'conversation'],
    gezels: lead('language-trainer'),
    params: {
      properties: { language: { type: 'string', title: 'Which language?', default: 'Spanish' } },
      required: ['language'],
    },
  },
  {
    id: 'flashcards',
    name: 'Flashcards',
    tags: ['flashcards', 'study', 'learning', 'spaced-repetition'],
    gezels: lead('study-buddy'),
    params: {
      properties: { subject: { type: 'string', title: 'What are you learning?' } },
      required: ['subject'],
    },
  },
  {
    id: 'novel-writing-room',
    name: 'Novel Writing Room',
    tags: ['writing', 'novel', 'fiction', 'drafting', 'wordcount'],
    gezels: lead('schrijfmaat'),
  },
  {
    id: 'just-chat',
    name: 'Chat',
    tags: ['chat', 'conversation', 'companion', 'casual', 'writing'],
    gezels: [{ templateId: 'conversationalist' }],
  },
];

describe('matchProjectTypeForBrief', () => {
  it('sends the family trip from the UX review to the Trip Planner, filled from its words', () => {
    const match = matchProjectTypeForBrief(
      'Plan a family trip to Portugal next spring: two adults and two kids (8 and 11), about ten days, Lisbon and the Algarve. Can you set up a crew?',
      TYPES,
    );
    expect(match).toEqual({
      typeId: 'trip-planner',
      hits: ['trip'],
      params: { destination: 'Portugal', start: 'next spring', travellers: '4' },
      assumed: [],
      dataFile: 'trip.json',
    });
  });

  it('says "soon" for a date the brief does not name, never the schema placeholder', () => {
    const match = matchProjectTypeForBrief('A trip to Kyoto with my sister', TYPES);
    expect(match?.params).toEqual({ destination: 'Kyoto', start: 'soon' });
    expect(match?.assumed).toEqual(['start']);
  });

  it('reads how many are going only when the brief says the whole count', () => {
    const party = (brief: string) => matchProjectTypeForBrief(brief, TYPES)?.params.travellers;
    expect(party('Plan a trip to Lisbon next spring for the four of us')).toBe('4');
    expect(party('A trip to Rome for a family of five')).toBe('5');
    expect(party('Trip to Oslo for 3 people in March')).toBe('3');
    expect(party('Honeymoon trip to Bali')).toBe('2');
    expect(party('A solo trip to Tokyo')).toBe('1');
    // Three friends and the writer, or three in all: not a guess to make.
    expect(party('A trip to Berlin with 3 friends')).toBeUndefined();
  });

  it('keeps a place on its own line', () => {
    // How the kickoff joins the project name to its about.
    expect(
      matchProjectTypeForBrief('Family trip to Portugal\nPlan a ten-day trip', TYPES)?.params,
    ).toMatchObject({ destination: 'Portugal' });
  });

  it('reads a lowercase destination', () => {
    expect(matchProjectTypeForBrief('help me plan a trip to lisbon', TYPES)?.params).toMatchObject({
      destination: 'Lisbon',
    });
  });

  it('reads an event and its date', () => {
    const match = matchProjectTypeForBrief('Plan our wedding on 12 June 2027', TYPES);
    expect(match?.typeId).toBe('event-planner');
    expect(match?.params).toEqual({ occasion: 'our wedding', date: '12 June 2027' });
  });

  it('does not match when a required parameter cannot be read from the brief', () => {
    // "Who is the care for?" is not something to guess.
    expect(
      matchProjectTypeForBrief('Keep track of medications and appointments', TYPES),
    ).toBeNull();
    // A trip with nowhere named would open on "somewhere wonderful".
    expect(matchProjectTypeForBrief('I need a packing list for a trip', TYPES)).toBeNull();
  });

  it('ignores tags more than one type shares', () => {
    // "family" belongs to two binders; "writing" to the novel room and chat.
    expect(matchProjectTypeForBrief('Help my family with writing', TYPES)).toBeNull();
  });

  it('never routes a request to build something', () => {
    expect(matchProjectTypeForBrief('Build me a website for our wedding', TYPES)).toBeNull();
    expect(matchProjectTypeForBrief('Make a trip planner app for Portugal', TYPES)).toBeNull();
    expect(matchProjectTypeForBrief('A landing page for my Lisbon trip', TYPES)).toBeNull();
  });

  it('needs a lead to hand the project to', () => {
    expect(matchProjectTypeForBrief('A casual chat companion', TYPES)).toBeNull();
  });

  it('declines a tie rather than guess between two types', () => {
    expect(
      matchProjectTypeForBrief('A trip to Rome for our wedding on 3 May 2027', TYPES),
    ).toBeNull();
  });

  it('lists every type a tied brief touches, so the person can settle it', () => {
    expect(
      projectTypesMentionedByBrief('A trip to Rome for our wedding on 3 May 2027', TYPES).sort(),
    ).toEqual(['event-planner', 'trip-planner']);
    expect(projectTypesMentionedByBrief('Build me a website for our wedding', TYPES)).toEqual([]);
  });

  it('reads a plural tag in its singular', () => {
    expect(projectTypeNamedByBrief('Help me write a guest list', TYPES)).toBe('event-planner');
    expect(projectTypeNamedByBrief('A flashcard deck for Dutch verbs', TYPES)).toBe('flashcards');
  });

  // Event Planner alone carries "planning", and a meester brief about
  // "planning healthy meals" tied it with Meal Planner (2026-10-14).
  it('never reads a word a goal is phrased in as a type of its own', () => {
    expect(projectTypeNamedByBrief('Planning for next quarter', TYPES)).toBeNull();
    expect(projectTypesMentionedByBrief('Planning a quiet week at home', TYPES)).toEqual([]);
  });

  it('reads a language by name', () => {
    expect(
      matchProjectTypeForBrief('A language tutor so I can practice Japanese', TYPES)?.params,
    ).toEqual({ language: 'Japanese' });
  });
});

describe('fillProjectTypeParams', () => {
  const trip = TYPES[0]!.params;

  it('reads ISO dates and named months', () => {
    expect(fillProjectTypeParams(trip, 'trip to Oslo on 2027-03-14')?.params.start).toBe(
      '2027-03-14',
    );
    expect(fillProjectTypeParams(trip, 'trip to Oslo in September 2027')?.params.start).toBe(
      'September 2027',
    );
  });

  it('does not read the verb "may" as a month', () => {
    expect(fillProjectTypeParams(trip, 'a trip to Oslo, it may rain')?.params.start).toBe('soon');
  });

  it('skips a season named as the place', () => {
    expect(fillProjectTypeParams(trip, 'travel in Spring to Norway')?.params.destination).toBe(
      'Norway',
    );
  });

  it('stops a place at the end of its sentence', () => {
    const place = (brief: string) => fillProjectTypeParams(trip, brief)?.params.destination;
    expect(place('Plan a trip to Lisbon.')).toBe('Lisbon');
    expect(place('Plan a trip to Rome. I want to see the Vatican')).toBe('Rome');
    expect(place('Plan a trip to St. Louis in May')).toBe('St. Louis');
    expect(place('Plan a trip to Washington D.C. next spring')).toBe('Washington D.C.');
    expect(place('Plan a trip to D.C. I want museums')).toBe('D.C.');
  });

  it('never makes a place out of what follows "trip to" when it is not one', () => {
    // A guess presented as the person's answer is the failure this module avoids.
    expect(fillProjectTypeParams(trip, 'Plan a trip to see my grandparents')).toBeNull();
    expect(fillProjectTypeParams(trip, 'Plan a trip to visit grandma')).toBeNull();
    expect(fillProjectTypeParams(trip, 'Plan a trip in two weeks')).toBeNull();
    expect(fillProjectTypeParams(trip, 'plan a trip to my parents')).toBeNull();
    expect(fillProjectTypeParams(trip, 'plan a trip to lisbon please')?.params.destination).toBe(
      'Lisbon',
    );
    expect(fillProjectTypeParams(trip, 'plan a trip to new york')?.params.destination).toBe(
      'New York',
    );
  });

  it('reads a lowercase month beside a day, and not a bare abbreviation', () => {
    expect(fillProjectTypeParams(trip, 'trip to Oslo on june 12')?.params.start).toBe('june 12');
    expect(fillProjectTypeParams(trip, 'trip to Oslo with Jan')?.params.start).toBe('soon');
    expect(fillProjectTypeParams(trip, 'trip to Oslo on Jan 12')?.params.start).toBe('Jan 12');
  });
});

describe('projectTypeNamedByBrief', () => {
  it('names the type a brief is about even when it lacks the details', () => {
    expect(matchProjectTypeForBrief('A trip somewhere nice', TYPES)).toBeNull();
    expect(projectTypeNamedByBrief('A trip somewhere nice', TYPES)).toBe('trip-planner');
    expect(projectTypeNamedByBrief('Bakery website', TYPES)).toBeNull();
    expect(projectTypeNamedByBrief('Lunch with Sam', TYPES)).toBeNull();
  });
});

describe('briefAsksForBuild', () => {
  it('reads making verbs before an app or game, and web words anywhere', () => {
    expect(briefAsksForBuild('Create a game where frogs cross roads')).toBe(true);
    expect(briefAsksForBuild('A personal web page')).toBe(true);
    expect(briefAsksForBuild('Put it in index.html')).toBe(true);
    expect(briefAsksForBuild('Play a game of chess with me')).toBe(false);
    expect(briefAsksForBuild('Plan a trip to Portugal')).toBe(false);
  });
});

describe('fillProjectTypeParams — first-project readers', () => {
  const one = (key: string, title: string, brief: string, extra: Record<string, unknown> = {}) =>
    fillProjectTypeParams(
      { properties: { [key]: { type: 'string', title, ...extra } }, required: [key] },
      brief,
    )?.params[key];

  it('reads who a household is in the words used', () => {
    expect(
      one('household', 'Who eats here?', 'Plan a week of meals for two adults and a toddler.'),
    ).toBe('two adults and a toddler');
    expect(one('household', 'Who eats here?', 'Two of us, no meat, cheap dinners please.')).toBe(
      'Two of us',
    );
  });

  it('reads what is being learned', () => {
    expect(
      one(
        'subject',
        'What are you learning?',
        'Make me flashcards to learn the capitals of Europe.',
      ),
    ).toBe('the capitals of Europe');
  });

  it('reads the role only when the brief is about a job', () => {
    expect(
      one(
        'role',
        'What role are you hunting for?',
        'Get me ready for a job interview as a product designer next month.',
      ),
    ).toBe('product designer');
    expect(
      one('role', 'What role are you hunting for?', 'Dress up as a pirate for the party.'),
    ).toBeUndefined();
  });

  it('reads what someone does, and who a feed speaks for', () => {
    expect(
      one(
        'business',
        'What do you do?',
        "I'm a freelance illustrator and I need to send invoices.",
      ),
    ).toBe('freelance illustrator');
    expect(
      one(
        'brand',
        'Who does this feed speak for?',
        'Plan a week of LinkedIn posts for my pottery studio.',
      ),
    ).toBe('pottery studio');
    expect(
      one(
        'brand',
        'Who does this feed speak for?',
        'I want to post on LinkedIn every day about our family brewery.',
      ),
    ).toBe('family brewery');
  });

  it('starts a required style choice from its default, never a free-text placeholder', () => {
    expect(
      one('personality', 'Table-talk style', 'Play chess with me.', {
        enum: ['in-character', 'peppy'],
        default: 'in-character',
      }),
    ).toBe('in-character');
    expect(
      one('personality', 'Table-talk style', 'Play chess with me.', { default: 'somebody' }),
    ).toBeUndefined();
  });
});
