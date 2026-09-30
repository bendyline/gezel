import { describe, expect, it } from 'vitest';
import {
  PROJECT_INSTRUCTIONS_END,
  PROJECT_INSTRUCTIONS_START,
  buildScopeQueryTerms,
  scopeInstructionsMarkdown,
  scopeProjectAboutForTier,
  tierGetsScopedInstructions,
} from './scope-instructions.js';

// A squisq-shaped imported-instructions block (between the markers).
// Sections are padded so the block clears the min-size gate and the
// budget logic actually has to choose.
const pad = (s: string) => `${s} ${'lorem ipsum dolor sit amet. '.repeat(40)}`;

const INSTRUCTIONS_INNER = [
  '## Agent instructions (imported from AGENTS.md)',
  '',
  '# Agent Guidelines for Squisq',
  '',
  'Squisq is an open-source monorepo for doc rendering and spatial utilities.',
  '',
  '## Project Overview',
  '',
  pad('Squisq provides spatial math (Haversine, Geohash) in the core package.'),
  '',
  '## Repository Structure',
  '',
  pad('packages/core/src/spatial/ holds Haversine.ts and Geohash.ts. spatial spatial spatial.'),
  '',
  '## Installing Dependencies',
  '',
  pad('Always install via npm run install:safe. Do not use a bare npm install.'),
  '',
  '## Build System',
  '',
  pad('npm run build builds all packages. npm test runs vitest.'),
  '',
  '## Theme System',
  '',
  pad('Themes bundle colors, typography, and render styles into one JSON object.'),
  '',
  '## JSON Form System',
  '',
  pad('A friendly editor + viewer for arbitrary JSON values bound to a JSON Schema.'),
  '',
  '## Adding a New Block Template',
  '',
  pad('Five required steps to register a template in the discriminated union.'),
  '',
  '## Code Style',
  '',
  pad('TypeScript strict mode. ESM only. catch (err: unknown) with instanceof narrowing.'),
  '',
  '## Type Safety Conventions',
  '',
  pad('Zero any in published production code. Use isTemplateBlock() to narrow.'),
].join('\n');

function aboutWithBlock(inner: string): string {
  return [
    'squisq is a workspace opened in VSCode.',
    '',
    PROJECT_INSTRUCTIONS_START,
    inner,
    PROJECT_INSTRUCTIONS_END,
  ].join('\n');
}

describe('tierGetsScopedInstructions', () => {
  it('scopes tiny/small/medium and leaves large/cloud/unknown whole', () => {
    expect(tierGetsScopedInstructions('tiny')).toBe(true);
    expect(tierGetsScopedInstructions('small')).toBe(true);
    expect(tierGetsScopedInstructions('medium')).toBe(true);
    expect(tierGetsScopedInstructions('large')).toBe(false);
    expect(tierGetsScopedInstructions('cloud')).toBe(false);
    expect(tierGetsScopedInstructions(undefined)).toBe(false);
  });
});

describe('buildScopeQueryTerms', () => {
  it('tokenizes title + step + deliverable path, dropping generic task words', () => {
    const terms = buildScopeQueryTerms({
      title: 'Address 3 High-Impact Bugs from Quality Audit Report',
      stepName: 'Analyze Bug #1: Geohash Accuracy',
      deliverableFile: 'packages/core/src/spatial/Geohash.ts',
    });
    // Path + step signal survives…
    expect(terms).toContain('geohash');
    expect(terms).toContain('spatial');
    expect(terms).toContain('core');
    // …generic task-management noise is filtered out.
    expect(terms).not.toContain('bug');
    expect(terms).not.toContain('audit');
    expect(terms).not.toContain('address');
  });

  it('splits camelCase in deliverable basenames', () => {
    const terms = buildScopeQueryTerms({ deliverableFile: 'src/ImageEditDoc.ts' });
    expect(terms).toEqual(expect.arrayContaining(['image', 'edit', 'doc']));
  });

  it('is empty for no task', () => {
    expect(buildScopeQueryTerms()).toEqual([]);
  });
});

describe('scopeInstructionsMarkdown', () => {
  const opts = { budgetChars: 6000, maxScoredSections: 6 };

  it('keeps the task-relevant section and drops unrelated ones', () => {
    const terms = buildScopeQueryTerms({
      stepName: 'Geohash Accuracy',
      deliverableFile: 'packages/core/src/spatial/Geohash.ts',
    });
    const { scoped, keptHeadings, omittedHeadings } = scopeInstructionsMarkdown(
      INSTRUCTIONS_INNER,
      terms,
      opts,
    );
    // Relevant + essential sections survive.
    expect(keptHeadings).toContain('Repository Structure'); // matches spatial/Geohash
    expect(keptHeadings).toContain('Code Style'); // essential
    expect(keptHeadings).toContain('Build System'); // essential
    expect(keptHeadings).toContain('Type Safety Conventions'); // essential
    // Irrelevant sections are dropped.
    expect(omittedHeadings).toContain('Theme System');
    expect(omittedHeadings).toContain('JSON Form System');
    // The wrapper/title header is always preserved.
    expect(scoped).toContain('imported from AGENTS.md');
    expect(scoped).toContain('# Agent Guidelines for Squisq');
    // A pointer to the dropped material is appended.
    expect(scoped).toContain('omitted to keep this prompt focused');
    expect(scoped).toContain('AGENTS.md');
  });

  it('always keeps essential sections even when the task matches nothing', () => {
    const { keptHeadings, omittedHeadings } = scopeInstructionsMarkdown(
      INSTRUCTIONS_INNER,
      ['nonexistentterm'],
      opts,
    );
    expect(keptHeadings).toEqual(
      expect.arrayContaining([
        'Project Overview',
        'Installing Dependencies',
        'Build System',
        'Code Style',
        'Type Safety Conventions',
      ]),
    );
    expect(omittedHeadings).toContain('Theme System');
    expect(omittedHeadings).toContain('JSON Form System');
  });

  it('preserves document order in the output', () => {
    const terms = buildScopeQueryTerms({ deliverableFile: 'spatial/Geohash.ts' });
    const { scoped } = scopeInstructionsMarkdown(INSTRUCTIONS_INNER, terms, opts);
    expect(scoped.indexOf('## Build System')).toBeLessThan(scoped.indexOf('## Code Style'));
    expect(scoped.indexOf('## Code Style')).toBeLessThan(
      scoped.indexOf('## Type Safety Conventions'),
    );
  });

  it('returns the block unchanged when there are no scoreable sections', () => {
    const flat = 'Just a paragraph of guidance with no ## headings at all.';
    const { scoped, omittedHeadings } = scopeInstructionsMarkdown(flat, ['anything'], opts);
    expect(scoped).toBe(flat);
    expect(omittedHeadings).toEqual([]);
  });
});

describe('scopeProjectAboutForTier', () => {
  const task = {
    title: 'Address 3 High-Impact Bugs',
    stepName: 'Analyze Bug #1: Geohash Accuracy',
    deliverableFile: 'packages/core/src/spatial/Geohash.ts',
  };

  it('slices the block for a small tier and shrinks the about', () => {
    const about = aboutWithBlock(INSTRUCTIONS_INNER);
    const out = scopeProjectAboutForTier(about, { tier: 'small', task });
    expect(out.length).toBeLessThan(about.length);
    expect(out).toContain('Geohash'); // relevant content kept
    expect(out).not.toContain('## Theme System'); // irrelevant section dropped
    // The human about stub and the markers are preserved.
    expect(out).toContain('squisq is a workspace opened in VSCode.');
    expect(out).toContain(PROJECT_INSTRUCTIONS_START);
    expect(out).toContain(PROJECT_INSTRUCTIONS_END);
  });

  it('returns the about verbatim for large/cloud tiers', () => {
    const about = aboutWithBlock(INSTRUCTIONS_INNER);
    expect(scopeProjectAboutForTier(about, { tier: 'large', task })).toBe(about);
    expect(scopeProjectAboutForTier(about, { tier: 'cloud', task })).toBe(about);
    expect(scopeProjectAboutForTier(about, { tier: undefined, task })).toBe(about);
  });

  it('returns the about verbatim when there is no imported-instructions block', () => {
    const about = 'squisq is a workspace opened in VSCode. Update this description.';
    expect(scopeProjectAboutForTier(about, { tier: 'small', task })).toBe(about);
  });

  it('returns the about verbatim when the block is too small to bother slicing', () => {
    const about = aboutWithBlock('## Overview\n\nA tiny guide.');
    expect(scopeProjectAboutForTier(about, { tier: 'small', task })).toBe(about);
  });

  it('does not churn the about when nothing would be dropped', () => {
    // Every section is essential → nothing omitted → original returned.
    const allEssential = [
      '## Agent instructions (imported from AGENTS.md)',
      '',
      '# Guide',
      '',
      '## Build System',
      '',
      pad('npm run build.'),
      '',
      '## Code Style',
      '',
      pad('strict mode.'),
      '',
      '## Type Safety Conventions',
      '',
      pad('no any.'),
    ].join('\n');
    const about = aboutWithBlock(allEssential);
    expect(scopeProjectAboutForTier(about, { tier: 'small', task })).toBe(about);
  });
});
