import scorecardJson from './data/scorecard.json' with { type: 'json' };
import { type ScorecardDataset, ScorecardDatasetSchema } from './schema.js';

export * from './schema.js';
export * from './report.js';

/**
 * The checked-in scorecard, parsed once.
 *
 * Deliberately NOT lazy and NOT forgiving: a malformed dataset is a build
 * error, not a runtime surprise. The handboek renders these numbers to
 * users, so a shape that no longer matches the schema must fail where an
 * engineer sees it rather than quietly render an empty table.
 */
export const SCORECARD: ScorecardDataset = ScorecardDatasetSchema.parse(scorecardJson);

/** True when no sweep has been recorded yet — articles degrade gracefully. */
export function scorecardIsEmpty(dataset: ScorecardDataset = SCORECARD): boolean {
  return dataset.results.length === 0;
}
