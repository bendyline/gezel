export * from './browser.js';
// Synchronous Node hashing remains available to existing server consumers.
export * from './recording/spec-hash.js';

export * from './tools/builtin-groups.js';
export * from './tools/access.js';
export * from './tools/envelope.js';
export * from './tools/native-tools.js';
export * from './tools/inputs.js';

export {
  MATCH_THRESHOLD,
  ROLE_ALIASES as GEZEL_ROLE_MATCH_ALIASES,
  rankCandidates,
  roleTokens,
  scoreCandidate,
} from './gezels/match.js';
export type { MatchCandidate, MatchScore } from './gezels/match.js';
export * from './gezels/templates.js';

export * from './deliverable-paths.js';

// Document → project-folder inference. Node-side: uses `node:path`.
export * from './project-inference/index.js';

export * from './workspace-edits.js';
export * from './workspace-edit-error.js';
