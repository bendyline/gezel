import { describe, expect, it } from 'vitest';
import {
  npmInstallAutoDecisions,
  permissionToProceedAutoAnswerText,
  pickAutoAnswerChoice,
  projectContextAutoAnswerText,
  repoSourceAutoAnswerText,
  workspaceFixtureAutoAnswerText,
} from './auto-answer.ts';

describe('pickAutoAnswerChoice', () => {
  it('returns 0 for an empty choice list (defensive)', () => {
    expect(pickAutoAnswerChoice([])).toBe(0);
  });

  it('returns 0 when nothing scores (preserves gezel ordering)', () => {
    expect(
      pickAutoAnswerChoice(['Minimalist & Scandinavian', 'Bold & Playful', 'Classic & Refined']),
    ).toBe(0);
  });

  it('skips an "upload" option in favor of a "generate" option (the petshop trial 8 case)', () => {
    const choices = [
      'Provide a logo image (upload)',
      'Generate the logo using the image-generator gezel',
      'Use a placeholder for now',
    ];
    expect(pickAutoAnswerChoice(choices)).toBe(1);
  });

  it('skips a "use placeholder" option', () => {
    const choices = ['Use a placeholder image for now', 'Render the icon with generate_image'];
    expect(pickAutoAnswerChoice(choices)).toBe(1);
  });

  it('skips a "user-provided" option', () => {
    const choices = [
      'Wait for the user to upload the asset',
      'Use stock imagery while we wait',
      'Generate the image now',
    ];
    expect(pickAutoAnswerChoice(choices)).toBe(2);
  });

  it('breaks ties by index when multiple choices score equally', () => {
    const choices = ['Generate via SDXL', 'Render via SDXL', 'Create via SDXL'];
    // All three contain a positive verb — earliest one wins.
    expect(pickAutoAnswerChoice(choices)).toBe(0);
  });

  it('prefers the named project over Default when choosing where to write a deliverable', () => {
    const choices = ['Default', 'Tank Combat Arcade'];

    expect(
      pickAutoAnswerChoice(choices, 'Which project should I write the `index.html` file to?'),
    ).toBe(1);
  });

  it('keeps Default as a valid choice for ordinary preference prompts', () => {
    const choices = ['Default', 'Bold & Playful'];

    expect(pickAutoAnswerChoice(choices, 'Which visual style should I use?')).toBe(0);
  });

  it('penalizes a "skip" option even when it has a positive verb mixed in', () => {
    const choices = ['Skip generating the logo for now', 'Generate the logo immediately'];
    // "Skip" still wins penalty over "generating" bonus → score 2-3 = -1
    // vs choice[1] score = 2.
    expect(pickAutoAnswerChoice(choices)).toBe(1);
  });

  // Wild-caught petshop e4b trial: the auto-answerer picked
  // "Install a standard AI image generation package (e.g., 'ai-generator')"
  // — the "generate" prefix outweighed any deferral signal — and steered
  // the team into npm-fantasy land for the rest of the run. The negative
  // keyword bank now covers `install <pkg> npm/library/module` to refuse
  // these even when they include the word "generate".
  it('penalizes an "install an X package" option even when it includes "generation" (petshop)', () => {
    const choices = [
      "Install a standard AI image generation package (e.g., 'ai-generator')",
      'Use the existing generate_image tool',
      'Use a placeholder for now',
    ];
    // Choice 0: positive "generate" +2, negative "install ... package" -3 → -1.
    // Choice 1: positive "generate_image" +2 → +2.
    // Choice 2: negative "placeholder" -3 → -3.
    expect(pickAutoAnswerChoice(choices)).toBe(1);
  });

  it('penalizes a "use a mock" option', () => {
    const choices = ['Use a mock service for image generation', 'Call generate_image directly'];
    expect(pickAutoAnswerChoice(choices)).toBe(1);
  });

  it('rewards a "delegate to the image-generator" option', () => {
    const choices = [
      'Install a third-party SDK to render the logo',
      'Delegate to the image-generator gezel',
    ];
    // Choice 0: -3 (install ... sdk). Choice 1: +2 (delegate to image-generator).
    expect(pickAutoAnswerChoice(choices)).toBe(1);
  });

  it('detects source-code deferral questions and answers with fetch_repo guidance', () => {
    const answer = repoSourceAutoAnswerText(
      'I am stuck because I do not have the source code for Squisq. To proceed, can you provide it?',
      ['Yes, please provide the source code now.', 'No, cancel the review.'],
    );

    expect(answer).toContain('fetch_repo');
    expect(answer).toContain('https://github.com/bendyline/squisq');
    expect(answer).toContain('Do not wait for source code from me');
  });

  it('does not trigger repo-source guidance for ordinary preference questions', () => {
    expect(
      repoSourceAutoAnswerText('Which visual style should I use for the logo?', [
        'Bold',
        'Minimal',
      ]),
    ).toBeNull();
  });

  it('answers missionObjectives deferral with project-context guidance', () => {
    const answer = projectContextAutoAnswerText(
      'Could you paste the full content of missionObjectives.md here so I can review progress?',
    );

    expect(answer).toContain('Do not wait for missionObjectives.md from me');
    expect(answer).toContain('write_file');
  });

  it('does not trigger project-context guidance for ordinary preference questions', () => {
    expect(projectContextAutoAnswerText('Which visual style should I use?')).toBeNull();
  });

  it('answers seeded workspace file deferral with read_file guidance', () => {
    const answer = workspaceFixtureAutoAnswerText(
      'Could you share the contents of facts/incident-brief.md and facts/legal-requirements.md?',
    );

    expect(answer).toContain('Do not wait for seeded workspace file contents from me');
    expect(answer).toContain('`facts/incident-brief.md`');
    expect(answer).toContain('read_file');
    expect(answer).toContain('write_file');
  });

  it('maps pathless seeded document names to workspace files', () => {
    const answer = workspaceFixtureAutoAnswerText(
      'Could you paste the key points from the incident brief, legal requirements, and voice guide?',
    );

    expect(answer).toContain('`facts/incident-brief.md`');
    expect(answer).toContain('`facts/legal-requirements.md`');
    expect(answer).toContain('`facts/voice-guide.md`');
    expect(answer).toContain('read_file');
  });

  it('does not trigger workspace fixture guidance for ordinary file instructions', () => {
    expect(
      workspaceFixtureAutoAnswerText('Re-read facts/incident-brief.md and repair the file.'),
    ).toBeNull();
  });

  it('declines npm install approvals with explicit package decisions', () => {
    expect(
      npmInstallAutoDecisions({
        kind: 'npm-install-approval',
        packages: [{ package: 'image-generator-cli', version: 'latest' }],
      }),
    ).toEqual([{ package: 'image-generator-cli', version: 'latest', decision: 'decline' }]);
  });

  it('turns a redundant handoff permission card into an operational answer', () => {
    expect(
      permissionToProceedAutoAnswerText(
        'Are you ready for me to hand off the relocation plan creation task to Deepak?',
      ),
    ).toContain('Call the required action or handoff tool now');
  });

  it('does not override a genuine preference question', () => {
    expect(permissionToProceedAutoAnswerText('Which visual style should I use?')).toBeNull();
  });

  it('declines every npm package — trials are hermetic and never reach the registry', () => {
    // The daemon side enforces the same policy via GEZEL_NPM_INSTALL_OFFLINE
    // (spawn.ts); this decline-all keeps stray pre-existing approval
    // questions consistent with it. Formerly a narrow eval-safe allowlist
    // (csv-parse/csv-parser/date-fns) — removed 2026-07-24: a mid-trial
    // registry fetch is both a hermeticity leak and a flake source.
    expect(
      npmInstallAutoDecisions({
        kind: 'npm-install-approval',
        packages: [
          { package: 'csv-parse', version: 'latest' },
          { package: 'left-pad', version: 'latest' },
        ],
      }),
    ).toEqual([
      { package: 'csv-parse', version: 'latest', decision: 'decline' },
      { package: 'left-pad', version: 'latest', decision: 'decline' },
    ]);
  });
});
