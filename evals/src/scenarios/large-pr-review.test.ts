import { describe, expect, it } from 'vitest';
import {
  API_DEFINITION_PATH,
  API_USE_PATH,
  LATE_DEFECT_PATH,
  buildLargePrArtifacts,
  largePrReviewScenario,
} from './large-pr-review.js';

describe('large-pr-review fixture', () => {
  it('is larger than the old bridge cap and contains 120 per-file records', () => {
    const artifacts = buildLargePrArtifacts();
    const records = artifacts.filter((artifact) => artifact.path.includes('/files/'));
    expect(records).toHaveLength(120);
    expect(artifacts.reduce((sum, artifact) => sum + artifact.content.length, 0)).toBeGreaterThan(
      80_000,
    );
  });

  it('places API use early, its definition late, and the real defect last', () => {
    const records = buildLargePrArtifacts().filter((artifact) => artifact.path.includes('/files/'));
    expect(records[0]?.content).toContain(`path: ${API_USE_PATH}`);
    expect(records.at(-2)?.content).toContain(`path: ${API_DEFINITION_PATH}`);
    expect(records.at(-1)?.content).toContain(`path: ${LATE_DEFECT_PATH}`);
    expect(records.at(-1)?.content).toContain('+  return true;');
  });

  it('asks for exact complete coverage and cross-file verification', () => {
    expect(largePrReviewScenario.prompt).toContain('Coverage: 120/120 changed files');
    expect(largePrReviewScenario.prompt).toContain('find_symbol');
    expect(largePrReviewScenario.prompt.toLowerCase()).toContain('do not modify source');
  });
});
