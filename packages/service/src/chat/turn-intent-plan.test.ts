import { TurnIntentPlanSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  detectExactArtifactRoute,
  falseCapabilityDenialCorrection,
  looksLikeImplementationRequest,
  renderTurnIntentPrelude,
  resolveTurnIntentPlan,
  shouldConstrainToExactCraftbookInvocation,
} from './turn-intent-plan.js';

describe('turn intent planning', () => {
  it('pre-resolves an exact PowerPoint request to its craftbook', () => {
    const plan = resolveTurnIntentPlan({
      text: 'Please make a PowerPoint about Mongolia.',
      isMeester: true,
      role: 'Meester',
    });

    expect(plan).toMatchObject({
      route: 'craftbook',
      confidence: 'high',
      output: { format: 'pptx' },
      craftbook: { id: 'powerpoint-deck' },
      requiredTools: ['invoke_craftbook'],
    });
    expect(renderTurnIntentPrelude(plan)).toContain('invoke_craftbook');
    expect(renderTurnIntentPrelude(plan)).not.toContain('DocBlocks');
    expect(TurnIntentPlanSchema.parse(plan)).toEqual(plan);
  });

  it('does not route informational file-format questions', () => {
    expect(detectExactArtifactRoute('What is a PPTX file?')).toBeNull();
    expect(detectExactArtifactRoute('How do PowerPoint files work?')).toBeNull();
    expect(detectExactArtifactRoute('Does PowerPoint support video?')).toBeNull();
  });

  it('suggests a developer only for action plus implementation subject', () => {
    expect(looksLikeImplementationRequest('Please fix the API integration tests')).toBe(true);
    expect(looksLikeImplementationRequest('What is an API?')).toBe(false);
    expect(
      resolveTurnIntentPlan({
        text: 'Please fix the API integration tests',
        isMeester: true,
        role: 'Meester',
      }),
    ).toMatchObject({ route: 'specialist', specialist: { role: 'developer' } });
  });

  it('narrows coordinator exact-format turns at every tier', () => {
    expect(
      shouldConstrainToExactCraftbookInvocation({
        role: 'Meester',
        latestUserMessage: 'Create a .pptx presentation for me',
      }),
    ).toBe(true);
    expect(
      shouldConstrainToExactCraftbookInvocation({
        role: 'Voorman',
        latestUserMessage: 'Create a .pptx presentation for me',
      }),
    ).toBe(true);
  });

  // A medium 27B Meester, handed the exact invoke_craftbook call twice over,
  // browsed its 49-tool menu instead and burned the turn on ensure_gezel.
  // Parameter count never predicted this; route confidence does.
  it('narrows a medium-tier meester on a resolved pptx route', () => {
    expect(
      shouldConstrainToExactCraftbookInvocation({
        role: 'Meester',
        latestUserMessage: 'Can you create a PowerPoint about France',
      }),
    ).toBe(true);
  });

  it('leaves non-coordinators and unrouted turns alone', () => {
    expect(
      shouldConstrainToExactCraftbookInvocation({
        role: 'Developer',
        latestUserMessage: 'Create a .pptx presentation for me',
      }),
    ).toBe(false);
    expect(
      shouldConstrainToExactCraftbookInvocation({
        role: 'Meester',
        latestUserMessage: 'What do you think of the deck so far?',
      }),
    ).toBe(false);
  });

  it('corrects a denial once when invoke was not attempted', () => {
    const plan = resolveTurnIntentPlan({
      text: 'Create a PowerPoint about Mongolia',
      isMeester: true,
      role: 'Meester',
    });
    expect(
      falseCapabilityDenialCorrection({
        plan,
        assistantContent: "I can't create a PowerPoint because I don't have a direct tool.",
        toolCalls: [],
      }),
    ).toContain('invoke_craftbook');
    expect(
      falseCapabilityDenialCorrection({
        plan,
        assistantContent: 'I can’t create it.',
        toolCalls: [{ name: 'mcp__gezel__invoke_craftbook', durationMs: 1, success: false }],
      }),
    ).toBeNull();
  });
});
