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
  CONDITIONALLY_REGISTERED_TOOLS,
  RENAMED_TOOLS,
  LEGACY_SPELLING_BY_CANONICAL,
  canonicalToolName,
  resolveToolNameSpelling,
  type AlwaysRegisteredToolName,
  type ConditionallyRegisteredToolName,
  type LegacyToolName,
} from './tool-inventory.js';
