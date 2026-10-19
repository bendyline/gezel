import { describe, expect, it } from 'vitest';
import { ToolRepeatTracker } from '../local-loop/tool-repeat-tracker.js';
import {
  FabricationDetectClaimWithoutTool,
  detectFabricatedToolClaim,
} from '../model-profile/behaviors/fabrication-detect-claim-without-tool.js';
import { PromptMeesterCraftbookPrelude } from '../model-profile/behaviors/prompt-meester-craftbook-prelude.js';
import { PromptWorkOptionsPrelude } from '../model-profile/behaviors/prompt-work-options-prelude.js';
import { PromptWorkOptionsQuestionNote } from '../model-profile/behaviors/prompt-work-options-question-note.js';
import { ToolsWorkRouting } from '../model-profile/behaviors/tools-work-routing.js';
import type { TurnCtx } from '../model-profile/types.js';
import type { ChatMessageToolCall } from '../schemas/gezel.js';
import { isProjectStartingCall } from './project-macro.js';
import { rankWorkOptions } from './rank.js';

function turnCtx(overrides: Partial<TurnCtx>): TurnCtx {
  return {
    catalogId: 'gemma4-e4b-q4',
    tier: 'small',
    family: 'gemma',
    modelId: 'gemma4-e4b-q4',
    providerName: 'llama-cpp',
    sessionId: 'sess-1',
    isMeester: true,
    projectId: 'default',
    messageOrigin: 'direct-user',
    availableToolNames: ['suggest_work', 'start_work'],
    userText: '',
    drained: [] as ChatMessageToolCall[],
    assistantContent: '',
    continuationCount: 0,
    ...overrides,
  };
}

const startWork = (option: string): ChatMessageToolCall =>
  ({ name: 'start_work', success: true, args: { option } }) as unknown as ChatMessageToolCall;

describe('isProjectStartingCall', () => {
  it('counts the project macros and the start_work options that make a project', () => {
    expect(isProjectStartingCall('start_project', {})).toBe(true);
    expect(isProjectStartingCall('start_work', { option: 'new-project' })).toBe(true);
    expect(isProjectStartingCall('start_work', { option: 'type:trip-planner' })).toBe(true);
  });

  it('leaves craftbook launches to the root-turn dedupe', () => {
    expect(isProjectStartingCall('start_work', { option: 'craftbook:status-report' })).toBe(false);
    expect(isProjectStartingCall('start_work', { option: 'task-here' })).toBe(false);
    expect(isProjectStartingCall('start_work', undefined)).toBe(false);
    expect(isProjectStartingCall('invoke_craftbook', { craftbookId: 'x' })).toBe(false);
  });
});

describe('claim-without-tool under work routing', () => {
  it('treats a successful start_work as the launch it performed', () => {
    const verdict = detectFabricatedToolClaim({
      text: "I've started a new project for your trip.",
      firedToolNames: ['suggest_work', 'start_work'],
    });
    expect(verdict.fabricated).toBe(false);
  });

  it('points the corrective at start_work when that is the roster', () => {
    const verdict = FabricationDetectClaimWithoutTool.postTurnDetector!(
      turnCtx({
        assistantContent: "I've started a new project for your trip.",
        drained: [{ name: 'suggest_work', success: true } as ChatMessageToolCall],
      }),
      undefined,
    );
    expect(verdict?.promptForNextTurn).toContain('start_work');
    expect(verdict?.promptForNextTurn).not.toContain('start_project');
  });

  it('accepts a craftbook claim backed by start_work', () => {
    const verdict = FabricationDetectClaimWithoutTool.postTurnDetector!(
      turnCtx({
        assistantContent: 'I started the status report task for you.',
        drained: [startWork('craftbook:status-report')],
      }),
      undefined,
    );
    expect(verdict).toBeNull();
  });
});

describe('preludes under work routing', () => {
  it('stands the craftbook prelude down when suggest_work is on the roster', () => {
    const text = 'I need a reusable recipe for onboarding a new client every month.';
    expect(
      PromptMeesterCraftbookPrelude.userPromptPrelude!(
        turnCtx({ userText: text, availableToolNames: ['suggest_craftbook', 'invoke_craftbook'] }),
        undefined,
      ),
    ).not.toBeNull();
    expect(
      PromptMeesterCraftbookPrelude.userPromptPrelude!(turnCtx({ userText: text }), undefined),
    ).toBeNull();
  });

  it('puts the pre-ranked options in front of the message', () => {
    const workOptions = rankWorkOptions({
      request: 'Plan a trip to Lisbon.',
      projectId: 'default',
      inDefault: true,
      workRequest: true,
      projectTypes: [{ typeId: 'trip-planner', name: 'Trip planner' }],
    });
    const out = PromptWorkOptionsPrelude.userPromptPrelude!(turnCtx({ workOptions }), undefined);
    expect(out).toContain('[type:trip-planner]');
    expect(
      PromptWorkOptionsPrelude.userPromptPrelude!(
        turnCtx({ workOptions, availableToolNames: ['start_project'] }),
        undefined,
      ),
    ).toBeNull();
    expect(
      PromptWorkOptionsPrelude.userPromptPrelude!(
        turnCtx({ workOptions, messageOrigin: 'background-nudge' }),
        undefined,
      ),
    ).toBeNull();
  });
});

describe('the question note', () => {
  const question = rankWorkOptions({
    request: "What's the difference between a Roth IRA and a traditional IRA?",
    projectId: 'default',
    inDefault: true,
    workRequest: true,
    selfTools: ['consult_researcher', 'search'],
  });

  it('tells the coordinator to answer a question itself, and nothing else does', () => {
    const out = PromptWorkOptionsQuestionNote.userPromptPrelude!(
      turnCtx({ workOptions: question }),
      undefined,
    );
    expect(out).toContain(
      'Answer it yourself in chat; do not start work or pass it to another gezel.',
    );
    expect(out).toContain('consult_researcher, search');
    expect(
      PromptWorkOptionsPrelude.userPromptPrelude!(turnCtx({ workOptions: question }), undefined),
    ).toBeNull();
  });

  it('stays silent for work, for nudges, and without the routing tools', () => {
    const work = rankWorkOptions({
      request: 'Plan a trip to Lisbon.',
      projectId: 'default',
      inDefault: true,
      workRequest: true,
      projectTypes: [{ typeId: 'trip-planner', name: 'Trip planner' }],
    });
    const note = (overrides: Partial<TurnCtx>) =>
      PromptWorkOptionsQuestionNote.userPromptPrelude!(turnCtx(overrides), undefined);
    expect(note({ workOptions: work })).toBeNull();
    expect(note({ workOptions: question, messageOrigin: 'background-nudge' })).toBeNull();
    expect(note({ workOptions: question, availableToolNames: ['start_project'] })).toBeNull();
  });
});

describe('the work-routing turn note', () => {
  const note = (overrides: Partial<TurnCtx>) =>
    ToolsWorkRouting.userPromptPrelude!(turnCtx(overrides), undefined);

  it('fires on the turns the build and craftbook preludes claim', () => {
    expect(note({ userText: 'Plan a trip to Lisbon next spring for the four of us.' })).toContain(
      'suggest_work',
    );
    expect(
      note({ userText: 'I need a reusable recipe for onboarding a new client every month.' }),
    ).toContain('suggest_work');
    expect(note({ userText: 'Clean up and dedupe the customer CSV exports.' })).toContain(
      'suggest_work',
    );
  });

  it('stays out of questions, other projects, answers and the ranked arm', () => {
    expect(note({ userText: 'What can you do?' })).toBeNull();
    expect(note({ userText: 'Build me a website for my bakery', projectId: 'bakery' })).toBeNull();
    expect(note({ userText: '[Answer to: "Which?"]\nSelected: A project' })).toBeNull();
    expect(
      note({ userText: 'Plan a trip to Lisbon.', availableToolNames: ['start_project'] }),
    ).toBeNull();
    const workOptions = rankWorkOptions({
      request: 'Plan a trip to Lisbon.',
      projectId: 'default',
      inDefault: true,
      workRequest: true,
    });
    expect(note({ userText: 'Plan a trip to Lisbon.', workOptions })).toBeNull();
  });
});

describe('ToolRepeatTracker — suggest_work', () => {
  it('turns a repeated ranking into the call it already named', () => {
    const tracker = new ToolRepeatTracker();
    const output = '1. [type:trip-planner] Trip planner\nCall start_work({ option: "<id>" }) …';
    tracker.recordCall('suggest_work', {}, output);
    const repeated = tracker.recordCall('suggest_work', {}, output);
    expect(repeated.shouldAbort).toBe(false);
    expect(repeated.output).toContain('start_work({ option: "type:trip-planner" })');
    expect(repeated.output).toContain('Do not call `suggest_work` again');
  });
});
