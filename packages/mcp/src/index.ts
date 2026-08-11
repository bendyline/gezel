/**
 * Public surface for the gezel-mcp workspace package. The server itself
 * runs as a standalone subprocess (`gezel-mcp` bin → `dist/server.js`),
 * but other workspace packages can import the tool inventory to predict
 * what surface the server will register without spawning it. The Codex
 * CLI session's `getRegisteredToolNames` uses this — Codex manages its
 * own MCP loop and gezel-daemon-side introspection isn't possible, so
 * the predicted list (minus per-provider exclusions) is the best signal
 * we can offer the debug bundle.
 */
export {
  ALWAYS_REGISTERED_TOOLS,
  BUILTIN_TOOL_NAMES,
  CANONICAL_TOOL_NAMES,
  CONDITIONALLY_REGISTERED_TOOLS,
  LEGACY_SPELLING_BY_CANONICAL,
  LEGACY_TOOL_NAMES,
  RENAMED_TOOLS,
  RESERVED_TOOL_NAMES,
  TOOL_REGISTRY,
  TOOL_NAME_TOMBSTONES,
  canonicalToolName,
  normalizeToolNameSpelling,
  resolveToolNameSpelling,
  type AlwaysRegisteredToolName,
  type CanonicalToolName,
  type CanonicalToolRegistryEntry,
  type ConditionallyRegisteredToolName,
  type LegacyToolName,
  type ToolRegistrationGate,
  type ToolNameTombstone,
} from './tool-inventory.js';
export {
  formatValidateResult,
  validateFile,
  type FileContent,
  type ValidateCheck,
  type ValidateResult,
} from './validate.js';
export {
  canUseLinuxSystemdDenyNet,
  unavailableToolsForPlatform,
} from './platform-tool-availability.js';
export {
  prioritizePullsForCurrentBranch,
  type BranchPrioritizedPulls,
  type PullWithHeadRef,
} from './github-pr-selection.js';
