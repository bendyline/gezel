/**
 * Model profiles: the per-model behaviors (prompt, turn, reasoning, MCP
 * wrappers) resolved from a catalog manifest or a capability tier. Shared by
 * the daemon and the portable runtime so a model is handled the same on both.
 */

export * from './types.js';
export * from './defaults.js';
export * from './registry.js';
export * from './local-model-tier.js';
export * from './tool-call-idiom.js';
export * from './tool-grammar.js';
export * from './behaviors/fabrication-detect-claim-without-tool.js';
export * from './behaviors/fabrication-detect-past-tense.js';
export * from './behaviors/index.js';
export * from './behaviors/mcp-compact-tool-schemas.js';
export * from './behaviors/mcp-default-missing-fields.js';
export * from './behaviors/mcp-relax-required-fields.js';
export * from './behaviors/mcp-validate-ids-strict.js';
export * from './behaviors/parse-gemma-special-token.js';
export * from './behaviors/prompt-derive-by-execution.js';
export * from './behaviors/prompt-documents-summaries.js';
export * from './behaviors/prompt-executor-context-trim.js';
export * from './behaviors/prompt-library-recall-prelude.js';
export * from './behaviors/prompt-meester-build-prelude.js';
export * from './behaviors/prompt-meester-craftbook-prelude.js';
export * from './behaviors/prompt-minimal-context.js';
export * from './behaviors/prompt-native-tool-call-format.js';
export * from './behaviors/prompt-prefer-writefile-edits.js';
export * from './behaviors/prompt-private-reasoning-guidance.js';
export * from './behaviors/prompt-retrieval-first.js';
export * from './behaviors/prompt-source-files-read-only.js';
export * from './behaviors/prompt-terse-visible-reply.js';
export * from './behaviors/prompt-tool-cookbook-condensed.js';
export * from './behaviors/prompt-tool-cookbook-full.js';
export * from './behaviors/prompt-verbose-reasoning-hint-channel.js';
export * from './behaviors/prompt-verbose-reasoning-hint-think.js';
export * from './behaviors/prompt-workspace-gestalt.js';
export * from './behaviors/provider-compact-write-transcript.js';
export * from './behaviors/provider-flatten-tool-transcript.js';
export * from './behaviors/provider-merge-system-messages.js';
export * from './behaviors/reasoning-capture-pre-tool-prose.js';
export * from './behaviors/reasoning-strip-channel-tags.js';
export * from './behaviors/reasoning-strip-think-tags.js';
export * from './behaviors/supervision-keurmeester.js';
export * from './behaviors/tools-gezels-as-roles.js';
export * from './behaviors/tools-mlx-grammar.js';
export * from './behaviors/tools-mlx-template-fix.js';
export * from './behaviors/turn-auto-acknowledge-tool-errors.js';
export * from './behaviors/turn-continuation-budget.js';
export * from './behaviors/turn-ollama-num-predict-bumped.js';
export * from './behaviors/turn-permission-stall.js';
export * from './behaviors/turn-preamble-folding.js';
export * from './behaviors/turn-ramble-detection.js';
export * from './behaviors/turn-single-tool-per-turn.js';
export * from './behaviors/validate-inline-js-parses.js';
