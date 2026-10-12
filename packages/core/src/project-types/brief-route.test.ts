import { describe, expect, it } from 'vitest';
import {
  type BriefRoutableType,
  briefAsksForBuild,
  fillProjectTypeParams,
  matchProjectTypeForBrief,
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
      params: { destination: 'Portugal', start: 'next spring' },
      assumed: [],
      dataFile: 'trip.json',
    });
  });

  it('says "soon" for a date the brief does not name, never the schema placeholder', () => {
    const match = matchProjectTypeForBrief('A trip to Kyoto with my sister', TYPES);
    expect(match?.params).toEqual({ destination: 'Kyoto', start: 'soon' });
    expect(match?.assumed).toEqual(['start']);
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

  it('reads a language by name', () => {
    expect(
      matchProjectTypeForBrief('A language tutor so I can practise Japanese', TYPES)?.params,
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
