import { describe, expect, it } from 'vitest';
import { parseWorkOptionId, workOptionId } from '../schemas/work-options.js';
import { looksLikeQuestionOrAdvice } from './question.js';
import { type WorkRankInput, rankWorkOptions } from './rank.js';
import { renderSuggestWorkResult, renderWorkOptionsPrelude, shortDescription } from './render.js';
import { projectNameFromRequest, routingRequestText } from './request.js';
import { isOrdinalWorkOptionId, shapeWorkOptions } from './shape.js';

describe('projectNameFromRequest', () => {
  it.each([
    [
      'Plan a trip to Lisbon next spring for the four of us, about a week, with a packing list.',
      'Plan a trip to Lisbon next spring',
    ],
    [
      'Start a project to practice Spanish with a language tutor. I know the basics.',
      'Practice Spanish with a language tutor',
    ],
    ['Can you build me a small website for my bakery?', 'Build me a small website for my'],
    ['hey, please make a tic-tac-toe game I can play', 'Make a tic-tac-toe game I can play'],
  ])('names %j as %j', (text, name) => {
    expect(projectNameFromRequest(text)).toBe(name);
  });

  it('falls back when nothing is left', () => {
    expect(projectNameFromRequest('please', 'Trip planner')).toBe('Trip planner');
  });
});

describe('routingRequestText', () => {
  it('reads an answer together with the request it answers', () => {
    expect(
      routingRequestText(
        '[Answer to: "What would you like help with?"]\nSelected: A document or report',
        'Help me with my thing for work',
      ),
    ).toBe(
      'Help me with my thing for work\n\n[Answer to: "What would you like help with?"]\nSelected: A document or report',
    );
  });

  it('leaves an ordinary request alone', () => {
    expect(routingRequestText('Write a status report', 'earlier')).toBe('Write a status report');
  });
});

describe('looksLikeQuestionOrAdvice', () => {
  it.each([
    'Quick question, no need to start anything: for a small single-user desktop app that stores a few thousand records, would you lean towards SQLite or Postgres, and why?',
    "What's 17 × 23?",
    'What can you do?',
    'How is the deck going?',
    'How do I write good meeting minutes?',
    'Should I use tabs or spaces?',
    'Which is better for a beginner, Spanish or Italian?',
    'Can you help me understand how recursion works?',
    'Quick question, please: should I use tabs or spaces?',
  ])('reads %j as a question', (text) => {
    expect(looksLikeQuestionOrAdvice(text)).toBe(true);
  });

  it.each([
    'Can you create a PowerPoint about Alaska?',
    'Plan a trip to Lisbon next spring for the four of us, about a week, with a packing list.',
    'Start a project to practice Spanish with a language tutor. I know the basics.',
    'Write a status report for my team: we shipped the new onboarding flow.',
    'Explain how this code folder works.',
    'Tell me what stands out in this spreadsheet.',
    'Help me with my thing for work',
    'I need a reusable recipe for onboarding a new client every month.',
    'Build me a small website for my bakery',
    'Is it possible to make a deck about Alaska?',
    'What should we eat this week? Two of us, no meat, cheap dinners please.',
    "Can you help me get better at French conversation? I'm a beginner.",
  ])('reads %j as a request for work', (text) => {
    expect(looksLikeQuestionOrAdvice(text)).toBe(false);
  });
});

describe('work option ids', () => {
  it('round-trips every action kind', () => {
    for (const parsed of [
      { kind: 'craftbook', craftbookId: 'status-report' },
      { kind: 'project-type', typeId: 'trip-planner' },
      { kind: 'new-project' },
      { kind: 'task-here' },
      { kind: 'recurring', key: 'cso:security-review', pause: false },
      { kind: 'recurring', key: 'cso:security-review', pause: true },
    ] as const) {
      expect(parseWorkOptionId(workOptionId(parsed))).toEqual(parsed);
    }
  });

  it('tolerates the noise a model adds when copying an id', () => {
    expect(parseWorkOptionId(' [type:trip-planner]. ')).toEqual({
      kind: 'project-type',
      typeId: 'trip-planner',
    });
    expect(parseWorkOptionId('"craftbook:status-report"')).toEqual({
      kind: 'craftbook',
      craftbookId: 'status-report',
    });
  });

  it('reads past a prefix put on an id that is something else', () => {
    expect(parseWorkOptionId('craftbook:new-project')).toEqual({ kind: 'new-project' });
    expect(parseWorkOptionId('type:task-here')).toEqual({ kind: 'task-here' });
    expect(parseWorkOptionId('craftbook:type:trip-planner')).toEqual({
      kind: 'project-type',
      typeId: 'trip-planner',
    });
    expect(parseWorkOptionId('craftbook:status-report')).toEqual({
      kind: 'craftbook',
      craftbookId: 'status-report',
    });
  });

  it('refuses unknown grammar', () => {
    expect(parseWorkOptionId('1')).toBeNull();
    expect(parseWorkOptionId('project:trip')).toBeNull();
    expect(parseWorkOptionId('craftbook:')).toBeNull();
  });
});

const DEFAULT_INPUT: WorkRankInput = {
  request: 'Plan a trip to Lisbon next spring for the four of us.',
  projectId: 'default',
  inDefault: true,
  workRequest: true,
  selfTools: ['consult_researcher'],
};

describe('rankWorkOptions', () => {
  it('returns an exact-format route alone', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      request: 'Can you create a PowerPoint about Alaska?',
      exact: { craftbookId: 'powerpoint-deck', name: 'PowerPoint from Content' },
      craftbooks: [{ craftbookId: 'content-deck', name: 'Content deck' }],
      newProject: true,
    });
    expect(result.options.map((o) => o.id)).toEqual(['craftbook:powerpoint-deck']);
    expect(result.guidance).toEqual([]);
  });

  it('offers a fitting project type without the recipes, and keeps the exit', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      projectTypes: [{ typeId: 'trip-planner', name: 'Trip planner' }],
      craftbooks: [{ craftbookId: 'itinerary-doc', name: 'Itinerary document' }],
    });
    expect(result.options.map((o) => o.id)).toEqual(['type:trip-planner']);
    expect(result.guidance.map((g) => g.kind)).toEqual(['self']);
  });

  it('keeps the recipes inside an existing project, where no type is offered', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      projectId: 'shop',
      inDefault: false,
      projectTypes: [{ typeId: 'trip-planner', name: 'Trip planner' }],
      craftbooks: [{ craftbookId: 'itinerary-doc', name: 'Itinerary document' }],
    });
    expect(result.options.map((o) => o.id)).toEqual(['craftbook:itinerary-doc', 'task-here']);
  });

  it('offers a build from Default its own project and leaves the recipes off', () => {
    const build = rankWorkOptions({
      ...DEFAULT_INPUT,
      request: 'Build me a small website for my bakery.',
      craftbooks: [{ craftbookId: 'branding-website', name: 'Branding website' }],
      newProject: true,
    });
    expect(build.options.map((o) => o.id)).toEqual(['new-project']);

    const typed = rankWorkOptions({
      ...DEFAULT_INPUT,
      projectTypes: [{ typeId: 'trip-planner', name: 'Trip planner' }],
      craftbooks: [{ craftbookId: 'itinerary-doc', name: 'Itinerary document' }],
      newProject: true,
    });
    expect(typed.options.map((o) => o.id)).toEqual(['type:trip-planner', 'new-project']);
  });

  it('caps the list at four', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      projectId: 'shop',
      inDefault: false,
      craftbooks: [
        { craftbookId: 'a', name: 'A' },
        { craftbookId: 'b', name: 'B' },
        { craftbookId: 'c', name: 'C' },
        { craftbookId: 'd', name: 'D' },
        { craftbookId: 'e', name: 'E' },
      ],
    });
    expect(result.options).toHaveLength(4);
  });

  it('puts the self verdict first for a question and drops weak matches', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      request: 'What can you do?',
      craftbooks: [
        { craftbookId: 'weak', name: 'Weak' },
        { craftbookId: 'strong', name: 'Strong', strong: true },
      ],
      projectTypes: [{ typeId: 'trip-planner', name: 'Trip planner' }],
      newProject: true,
    });
    expect(result.guidance[0]?.kind).toBe('self');
    expect(result.options.map((o) => o.id)).toEqual(['craftbook:strong']);
  });

  it('treats follow-ups on existing work as questions', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      request: 'Cancel the PowerPoint task',
      workRequest: false,
      craftbooks: [{ craftbookId: 'powerpoint-deck', name: 'PowerPoint' }],
    });
    expect(result.options).toEqual([]);
    expect(result.guidance.map((g) => g.kind)).toEqual(['self']);
  });

  it('offers projects only where a new project is a destination', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      request: 'Write the about-page copy',
      projectId: 'bakery-site',
      inDefault: false,
      projectTypes: [{ typeId: 'trip-planner', name: 'Trip planner' }],
      newProject: true,
    });
    expect(result.options.map((o) => o.id)).toEqual(['task-here']);
  });

  it('offers a new project from inside one only when it was asked for', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      request: 'Start a new project for a bakery website',
      projectId: 'bakery-site',
      inDefault: false,
      separateProject: true,
      newProject: true,
    });
    expect(result.options.map((o) => o.id)).toEqual(['new-project']);
  });

  it('points implementation work in a project at the specialist', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      request: 'Fix the checkout bug in the cart code',
      projectId: 'bakery-site',
      inDefault: false,
      implementation: true,
      specialist: { role: 'developer', tool: 'delegate_developer' },
    });
    expect(result.guidance.map((g) => g.kind)).toEqual(['specialist', 'self']);
  });

  it('offers authoring when no recipe fits a repeatable procedure', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      request: 'I need a reusable recipe for onboarding a new client every month.',
      procedure: true,
      craftbooks: [{ craftbookId: 'client-intake', name: 'Client intake' }],
    });
    expect(result.options.map((o) => o.id)).toEqual(['craftbook:client-intake']);
    expect(result.guidance.map((g) => g.kind)).toEqual(['author', 'self']);
  });

  it('does not offer authoring when a project type is the whole job', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      request: 'I want to post on LinkedIn every day next week about my coffee roastery.',
      procedure: true,
      projectTypes: [{ typeId: 'social-feed', name: 'Social Feed' }],
      craftbooks: [{ craftbookId: 'draft-social-post', name: 'Draft a social post' }],
    });
    expect(result.options.map((o) => o.id)).toEqual(['type:social-feed']);
    expect(result.guidance.map((g) => g.kind)).toEqual(['self']);
  });

  it('asks when nothing fits a vague request', () => {
    const result = rankWorkOptions({ ...DEFAULT_INPUT, request: 'Help me with my thing for work' });
    expect(result.options).toEqual([]);
    expect(result.guidance.map((g) => g.kind)).toEqual(['ask', 'self']);
  });

  it('offers recurring work, switched on or paused', () => {
    const result = rankWorkOptions({
      ...DEFAULT_INPUT,
      request: 'Stop the nightly security review',
      projectId: 'shop',
      inDefault: false,
      recurring: [{ key: 'cso:security-review', name: 'Security review', pause: true }],
    });
    expect(result.options[0]?.id).toBe('recurring-pause:cso:security-review');
  });
});

describe('renderSuggestWorkResult', () => {
  it('renders an exact route as one call', () => {
    const text = renderSuggestWorkResult(
      rankWorkOptions({
        ...DEFAULT_INPUT,
        request: 'Can you create a PowerPoint about Alaska?',
        exact: {
          craftbookId: 'powerpoint-deck',
          name: 'PowerPoint from Content',
          setupRequired: ['docblocks'],
        },
      }),
    );
    expect(text).toContain('Exact match: [craftbook:powerpoint-deck]');
    expect(text).toContain('[needs setup: docblocks]');
    expect(text).toContain('start_work({ option: "craftbook:powerpoint-deck" }) now');
  });

  it('lists options, then the start line, then the exit', () => {
    const text = renderSuggestWorkResult(
      rankWorkOptions({
        ...DEFAULT_INPUT,
        projectTypes: [{ typeId: 'trip-planner', name: 'Trip planner', description: 'A board.' }],
      }),
    );
    expect(text.split('\n')).toEqual([
      '1. [type:trip-planner] Trip planner — A board',
      expect.stringContaining('Call start_work({ option: "<id>" })'),
      'If none of these fits, answer in chat yourself. If you need help, you have consult_researcher.',
    ]);
  });

  it('leads with the answer for a question', () => {
    const text = renderSuggestWorkResult(
      rankWorkOptions({ ...DEFAULT_INPUT, request: "What's 17 × 23?" }),
    );
    expect(text.startsWith('This reads as a question: answer it yourself in chat.')).toBe(true);
    expect(text).not.toContain('start_work({');
  });

  it('writes an ask verdict as a ready ask_user_question call', () => {
    const text = renderSuggestWorkResult(
      rankWorkOptions({ ...DEFAULT_INPUT, request: 'Help me with my thing for work' }),
    );
    expect(text).toContain('ask_user_question({ question: "What would you like help with?"');
  });
});

describe('renderWorkOptionsPrelude', () => {
  it('stays silent for questions and empty lists', () => {
    expect(
      renderWorkOptionsPrelude(rankWorkOptions({ ...DEFAULT_INPUT, request: 'What can you do?' })),
    ).toBeNull();
    expect(
      renderWorkOptionsPrelude(
        rankWorkOptions({ ...DEFAULT_INPUT, request: 'Help me with my thing for work' }),
      ),
    ).toBeNull();
  });

  it('frames the list as already looked up', () => {
    const text = renderWorkOptionsPrelude(
      rankWorkOptions({
        ...DEFAULT_INPUT,
        projectTypes: [{ typeId: 'trip-planner', name: 'Trip planner' }],
      }),
    );
    expect(text ?? '').toMatch(/^\(System note for this turn: suggest_work already ran/);
    expect(text ?? '').toContain('[type:trip-planner]');
  });
});

describe('shapeWorkOptions', () => {
  const ranked = () =>
    rankWorkOptions({
      ...DEFAULT_INPUT,
      projectTypes: [
        { typeId: 'trip-planner', name: 'Trip planner', description: 'A board.' },
        { typeId: 'event-planner', name: 'Event planner' },
      ],
    });

  it('numbers the options and asks start_work for the number', () => {
    const text = renderSuggestWorkResult(ranked(), { ordinalIds: true });
    expect(text.split('\n').slice(0, 3)).toEqual([
      '1. Trip planner — A board',
      '2. Event planner',
      expect.stringContaining('Call start_work({ option: "<number>" })'),
    ]);
    expect(isOrdinalWorkOptionId('2')).toBe(true);
    expect(isOrdinalWorkOptionId('type:trip-planner')).toBe(false);
  });

  it('drops the guidance lines, or every option after the first', () => {
    const bare = renderSuggestWorkResult(shapeWorkOptions(ranked(), { noGuidance: true }));
    expect(bare).not.toContain('answer in chat yourself');
    expect(bare).toContain('[type:event-planner]');

    const top = shapeWorkOptions(ranked(), { maxOptions: 1 });
    expect(top.options.map((o) => o.id)).toEqual(['type:trip-planner']);
    expect(renderSuggestWorkResult(top)).toContain('answer in chat yourself');
  });

  it('changes nothing when no variant is asked for', () => {
    expect(shapeWorkOptions(ranked(), {})).toEqual(ranked());
  });
});

describe('shortDescription', () => {
  it('keeps the first sentence or clause, capped', () => {
    expect(
      shortDescription(
        'Localize and translate content into a target language: it first scopes the target locale, then translates.',
      ),
    ).toBe('Localize and translate content into a target language');
    expect(shortDescription('Stop practicing what you already know. Read the review record.')).toBe(
      'Stop practicing what you already know',
    );
    expect(shortDescription('Produces a real PowerPoint (.pptx).')).toBe(
      'Produces a real PowerPoint (.pptx)',
    );
    expect(shortDescription('x'.repeat(300))).toHaveLength(140);
  });
});
