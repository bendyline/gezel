import { describe, expect, it } from 'vitest';
import {
  countExistingSourceFilenameMentions,
  pickBestSquisqReviewCandidate,
  squisqReviewScenario,
} from './squisq-review.ts';

describe('countExistingSourceFilenameMentions', () => {
  const actualPaths = [
    'package.json',
    'tsconfig.json',
    'packages/site/src/App.tsx',
    'packages/video/src/index.ts',
    'packages/video-react/src/VideoExportButton.tsx',
    'e2e/editor.spec.ts',
  ];

  it('counts only filenames that exist in the workspace', () => {
    const count = countExistingSourceFilenameMentions(
      [
        '`package.json`',
        '`tsconfig.json`',
        '`src/main.ts`',
        '`lib/index.js`',
        '`tests/integration.test.ts`',
      ].join('\n'),
      actualPaths,
    );

    expect(count).toBe(2);
  });

  it('counts real nested source paths and basename-only root files once', () => {
    const count = countExistingSourceFilenameMentions(
      [
        '`package.json`',
        '`packages/site/src/App.tsx`',
        '`packages/video/src/index.ts`',
        '`packages/video-react/src/VideoExportButton.tsx`',
        '`e2e/editor.spec.ts`',
        '`packages/site/src/App.tsx`',
      ].join('\n'),
      actualPaths,
    );

    expect(count).toBe(5);
  });
});

describe('squisqReviewScenario prompt', () => {
  it('makes fetch_repo the mandatory first tool and rejects empty project macros', () => {
    expect(squisqReviewScenario.prompt).toContain('MANDATORY FIRST TOOL CALL');
    expect(squisqReviewScenario.prompt).toContain('fetch_repo');
    expect(squisqReviewScenario.prompt).toContain('Do not call `start_project`');
    expect(squisqReviewScenario.prompt).toContain('expectedDeliverable');
    expect(squisqReviewScenario.prompt).toContain('project: <the new project id>');
  });
});

describe('pickBestSquisqReviewCandidate', () => {
  it('prefers a later passing review over an earlier weak draft', () => {
    const paths = [
      'package.json',
      'tsconfig.json',
      'packages/site/src/App.tsx',
      'packages/video/src/index.ts',
      'packages/video-react/src/VideoExportButton.tsx',
      'e2e/editor.spec.ts',
    ];
    const weak = '# Review\n\n## Architecture\n\nShort overview only.';
    const strong = [
      '# Review',
      '',
      '## Architecture',
      'Squisq is organized across `package.json`, `tsconfig.json`, `packages/site/src/App.tsx`, `packages/video/src/index.ts`, `packages/video-react/src/VideoExportButton.tsx`, and `e2e/editor.spec.ts`.',
      '',
      '## Major issues',
      'P1: The package boundaries need clearer enforcement. '.repeat(35),
      '',
      '## Minor issues',
      'P2: Some naming and test coverage issues are visible. '.repeat(25),
      '',
      '## Recommendations',
      'Prioritize package-boundary tests and focused documentation. '.repeat(35),
    ].join('\n');

    const best = pickBestSquisqReviewCandidate(
      [
        { text: weak, location: 'workspace/squisq-code-review/review.md', projectId: 'one' },
        { text: strong, location: 'workspace/squisq-code-review-2/review.md', projectId: 'two' },
      ],
      paths,
    );

    expect(best?.location).toBe('workspace/squisq-code-review-2/review.md');
    expect(best?.failReason).toBeNull();
  });
});

describe('countExistingSourceFilenameMentions — fabricated-path loophole', () => {
  it('invented paths ending in COMMON basenames do not count as citations', async () => {
    const { countExistingSourceFilenameMentions } = await import('./squisq-review.ts');
    const realPaths = [
      'packages/core/src/index.ts',
      'packages/cli/src/index.ts',
      'packages/core/src/spatial/Geohash.ts',
    ];
    // `lib/index.ts` does not exist; index.ts basename is ambiguous (2 files).
    const review = 'See `lib/index.ts` and `app/index.ts` for the entry points.';
    expect(countExistingSourceFilenameMentions(review, realPaths)).toBe(0);
  });

  it('a unique basename cited without its directory still counts', async () => {
    const { countExistingSourceFilenameMentions } = await import('./squisq-review.ts');
    const realPaths = ['packages/core/src/spatial/Geohash.ts', 'packages/core/src/index.ts'];
    const review = 'The bug lives in `Geohash.ts` near the encoder.';
    expect(countExistingSourceFilenameMentions(review, realPaths)).toBe(1);
  });
});

describe('listFabricatedSourceMentions', () => {
  it('names invented paths and skips real/unique ones', async () => {
    const { listFabricatedSourceMentions } = await import('./squisq-review.ts');
    const real = ['packages/core/src/spatial/Geohash.ts', 'packages/core/src/index.ts'];
    const review =
      'See `src/utils/helpers.ts` and `packages/core/src/spatial/Geohash.ts` and `tests/unit/test_runner.ts`.';
    const fabricated = listFabricatedSourceMentions(review, real);
    expect(fabricated).toContain('src/utils/helpers.ts');
    expect(fabricated).toContain('tests/unit/test_runner.ts');
    expect(fabricated).not.toContain('packages/core/src/spatial/geohash.ts');
  });
});
