/**
 * Master list of every runtime behavior known to this engine.
 *
 * Adding a new behavior:
 *   1. Drop the impl file alongside this one (e.g. `my-new-behavior.ts`)
 *      exporting `MyNewBehavior: Behavior<TConfig>`.
 *   2. Append the import + entry to {@link ALL_BEHAVIORS} below.
 *
 * No registry-side changes — the central registry in `registry.ts`
 * indexes this list by `behavior.id` at module load.
 *
 * Order matters when behaviors compose under the same hook
 * (`promptAppend` concatenates results in declaration order;
 * `stripVisibleContent` runs left-to-right). Keep that in mind when
 * inserting new entries.
 */

import type { Behavior } from '../types.js';
import { FabricationDetectClaimWithoutTool } from './fabrication-detect-claim-without-tool.js';
import { FabricationDetectPastTense } from './fabrication-detect-past-tense.js';
import { McpCompactToolSchemas } from './mcp-compact-tool-schemas.js';
import { McpDefaultMissingFields } from './mcp-default-missing-fields.js';
import { McpRelaxRequiredFields } from './mcp-relax-required-fields.js';
import { McpValidateIdsStrict } from './mcp-validate-ids-strict.js';
import { ParseGemmaSpecialToken } from './parse-gemma-special-token.js';
import { PromptDeriveByExecution } from './prompt-derive-by-execution.js';
import { PromptExecutorContextTrim } from './prompt-executor-context-trim.js';
import { PromptMeesterBuildPrelude } from './prompt-meester-build-prelude.js';
import { PromptMeesterCraftbookPrelude } from './prompt-meester-craftbook-prelude.js';
import { PromptMinimalContext } from './prompt-minimal-context.js';
import { PromptNativeToolCallFormat } from './prompt-native-tool-call-format.js';
import { PromptPreferWritefileEdits } from './prompt-prefer-writefile-edits.js';
import { PromptPrivateReasoningGuidance } from './prompt-private-reasoning-guidance.js';
import { PromptRetrievalFirst } from './prompt-retrieval-first.js';
import { PromptSourceFilesReadOnly } from './prompt-source-files-read-only.js';
import { PromptTerseVisibleReply } from './prompt-terse-visible-reply.js';
import { PromptToolCookbookCondensed } from './prompt-tool-cookbook-condensed.js';
import { PromptToolCookbookFull } from './prompt-tool-cookbook-full.js';
import { PromptVerboseReasoningHintChannel } from './prompt-verbose-reasoning-hint-channel.js';
import { PromptVerboseReasoningHintThink } from './prompt-verbose-reasoning-hint-think.js';
import { PromptWorkspaceGestalt } from './prompt-workspace-gestalt.js';
import { ProviderCompactWriteTranscript } from './provider-compact-write-transcript.js';
import { ProviderFlattenToolTranscript } from './provider-flatten-tool-transcript.js';
import { ProviderMergeSystemMessages } from './provider-merge-system-messages.js';
import { ReasoningCapturePreToolProse } from './reasoning-capture-pre-tool-prose.js';
import { ReasoningStripChannelTags } from './reasoning-strip-channel-tags.js';
import { ReasoningStripThinkTags } from './reasoning-strip-think-tags.js';
import { SupervisionKeurmeester } from './supervision-keurmeester.js';
import { ToolsGezelsAsRoles } from './tools-gezels-as-roles.js';
import { ToolsMlxGrammar } from './tools-mlx-grammar.js';
import { ToolsMlxTemplateFix } from './tools-mlx-template-fix.js';
import { TurnAutoAcknowledgeToolErrors } from './turn-auto-acknowledge-tool-errors.js';
import { TurnContinuationBudget } from './turn-continuation-budget.js';
import { TurnOllamaNumPredictBumped } from './turn-ollama-num-predict-bumped.js';
import { TurnPermissionStall } from './turn-permission-stall.js';
import { TurnPreambleFolding } from './turn-preamble-folding.js';
import { TurnRambleDetection } from './turn-ramble-detection.js';
import { TurnSingleToolPerTurn } from './turn-single-tool-per-turn.js';
import { ValidateInlineJsParses } from './validate-inline-js-parses.js';

// Step-3 imports land here, one per migrated knob.

export const ALL_BEHAVIORS: ReadonlyArray<Behavior<unknown>> = [
  FabricationDetectPastTense as Behavior<unknown>,
  FabricationDetectClaimWithoutTool as Behavior<unknown>,
  PromptMeesterBuildPrelude as Behavior<unknown>,
  PromptMeesterCraftbookPrelude as Behavior<unknown>,
  PromptExecutorContextTrim as Behavior<unknown>,
  PromptMinimalContext as Behavior<unknown>,
  PromptWorkspaceGestalt as Behavior<unknown>,
  PromptRetrievalFirst as Behavior<unknown>,
  PromptToolCookbookFull as Behavior<unknown>,
  PromptToolCookbookCondensed as Behavior<unknown>,
  PromptPrivateReasoningGuidance as Behavior<unknown>,
  PromptVerboseReasoningHintThink as Behavior<unknown>,
  PromptVerboseReasoningHintChannel as Behavior<unknown>,
  // Placed AFTER the cookbook + reasoning-guidance entries so their
  // `promptAppend` override blocks concatenate last (recency wins for
  // local models). See each behavior's header for the override rationale.
  PromptPreferWritefileEdits as Behavior<unknown>,
  PromptDeriveByExecution as Behavior<unknown>,
  // After prefer-writefile-edits: that behavior steers small models toward
  // positional edits, which is exactly the surface that mis-targets onto a
  // read-only input. The guard must be read after the steer.
  PromptSourceFilesReadOnly as Behavior<unknown>,
  PromptTerseVisibleReply as Behavior<unknown>,
  // LAST of the prompt-append block on purpose. The cookbook tells models
  // "never write tool-use markup … real calls go through the function-calling
  // channel", which is false on MLX (there is no such channel — salvage is the
  // only path). For a model with no decode-time grammar this block has to be
  // the one that lands last, or the cookbook's rule wins and the model
  // suppresses the only syntax that works.
  PromptNativeToolCallFormat as Behavior<unknown>,
  ReasoningStripThinkTags as Behavior<unknown>,
  ReasoningStripChannelTags as Behavior<unknown>,
  ReasoningCapturePreToolProse as Behavior<unknown>,
  ProviderCompactWriteTranscript as Behavior<unknown>,
  TurnContinuationBudget as Behavior<unknown>,
  TurnOllamaNumPredictBumped as Behavior<unknown>,
  TurnPreambleFolding as Behavior<unknown>,
  TurnRambleDetection as Behavior<unknown>,
  TurnAutoAcknowledgeToolErrors as Behavior<unknown>,
  TurnPermissionStall as Behavior<unknown>,
  TurnSingleToolPerTurn as Behavior<unknown>,
  McpCompactToolSchemas as Behavior<unknown>,
  McpRelaxRequiredFields as Behavior<unknown>,
  McpDefaultMissingFields as Behavior<unknown>,
  McpValidateIdsStrict as Behavior<unknown>,
  ParseGemmaSpecialToken as Behavior<unknown>,
  ProviderFlattenToolTranscript as Behavior<unknown>,
  ProviderMergeSystemMessages as Behavior<unknown>,
  SupervisionKeurmeester as Behavior<unknown>,
  ToolsGezelsAsRoles as Behavior<unknown>,
  ToolsMlxGrammar as Behavior<unknown>,
  ToolsMlxTemplateFix as Behavior<unknown>,
  ValidateInlineJsParses as Behavior<unknown>,
];
