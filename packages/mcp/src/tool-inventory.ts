/**
 * The canonical tool inventory moved to core so the daemon's prompt builder
 * and the portable runtime read the same registry; this module keeps the
 * package's public names.
 */
export {
  ALWAYS_REGISTERED_TOOLS,
  BUILTIN_TOOL_NAMES,
  CANONICAL_TOOL_NAMES,
  CONDITIONALLY_REGISTERED_TOOLS,
  HOST_CALLBACK_TOOLS,
  LEGACY_SPELLING_BY_CANONICAL,
  LEGACY_TOOL_NAMES,
  RESERVED_TOOL_NAMES,
  TOOL_NAME_TOMBSTONES,
  TOOL_REGISTRY,
  distributionWithheldTools,
  normalizeToolNameSpelling,
  resolveToolNameSpelling,
  type AlwaysRegisteredToolName,
  type CanonicalToolName,
  type CanonicalToolRegistryEntry,
  type ConditionallyRegisteredToolName,
  type ToolNameTombstone,
  type ToolRegistrationGate,
} from '@bendyline/gezel/local-loop';
export { canonicalToolName, type LegacyToolName, RENAMED_TOOLS } from '@bendyline/gezel';
