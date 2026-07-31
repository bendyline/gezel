/**
 * Registry of MCP wrappers shipped with gezel. The bridge picks the
 * subset that match a given server spec at startup.
 *
 * Adding a new wrapper: drop a file alongside `playwright-snapshot.ts`,
 * implement the {@link McpToolWrapper} interface, and append it here.
 * No bridge-side changes required.
 */
import type { McpServerSpec } from '../mcp-bridge.js';
import { OutboardStorage } from './outboard-storage.js';
import { PlaywrightArgValidator } from './playwright-arg-validator.js';
import { PlaywrightAutoScreenshot } from './playwright-auto-screenshot.js';
import { PlaywrightSnapshotInliner } from './playwright-snapshot.js';
import { PlaywrightToolDescriptions } from './playwright-tool-descriptions.js';
import { SourceWriteGuard } from './source-write-guard.js';
import { TaskStepArgNormalizer } from './task-step-arg-normalizer.js';
import type { McpToolWrapper } from './types.js';
import { WorkspacePathNormalizer } from './workspace-path-normalizer.js';
import { ZodErrorTranslator } from './zod-error-translator.js';

/**
 * Static wrappers — universal, always-on adapters that run on every
 * matching bridge regardless of the resolved profile. Per-model
 * behaviors that contribute MCP wrappers (e.g. `mcp.relax-required-
 * fields`, `mcp.default-missing-fields`, `mcp.validate-ids-strict`,
 * `turn.single-tool-per-turn`) compose alongside this list — see
 * {@link McpBridge.start}'s `behaviorWrappersFor` call.
 *
 * Order matters per-hook:
 *
 *   - decorateTools: Playwright descriptions rewriter is the only
 *     decorator here; behavior-driven decorators run before the
 *     statics so the schema model the model sees is what the bridge
 *     publishes.
 *   - preProcess: Playwright validator rejects bad URLs.
 *   - postProcess: snapshot inliner has to run before auto-screenshot
 *     so the image-attached note doesn't overlap the file-link
 *     replacement.
 *   - postProcessError: ZodErrorTranslator runs every tier, every
 *     server — translates raw Zod blobs into plain English before
 *     they reach the model.
 */
export const ALL_WRAPPERS: readonly McpToolWrapper[] = [
  WorkspacePathNormalizer,
  TaskStepArgNormalizer,
  SourceWriteGuard,
  ZodErrorTranslator,
  PlaywrightToolDescriptions,
  PlaywrightArgValidator,
  PlaywrightSnapshotInliner,
  PlaywrightAutoScreenshot,
  // OutboardStorage runs LAST in postProcess so any earlier wrapper's
  // transformations (e.g. PlaywrightSnapshotInliner expanding a
  // [Snapshot](path) link into a fully-inlined aria tree, +
  // PlaywrightAutoScreenshot appending an auto-screenshot note) get
  // reflected in the persisted artifact + summary preview. If we ran
  // earlier, the artifact would hold the raw-link version while the
  // model's response would describe the enhanced one — confusing.
  OutboardStorage,
];

export function selectWrappersFor(spec: McpServerSpec): readonly McpToolWrapper[] {
  return ALL_WRAPPERS.filter((w) => {
    try {
      return w.matches(spec);
    } catch {
      return false;
    }
  });
}

export type { McpToolWrapper, McpToolWrapperContext, McpToolResult } from './types.js';
