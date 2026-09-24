import { fillMainContentParam } from '@bendyline/gezel';
import { z } from 'zod';
import {
  type BinaryDocumentCraftbookRoute,
  binaryDocumentCraftbookRoute,
  isBinaryDocumentOutputPath,
  normalizeDocumentOutputPath,
} from './document-routing.js';
import { inferSourceDeliverablePath } from './kickoff-text.js';
import { coerceJsonObject } from './zod-coerce.js';

/**
 * Actual invoke_craftbook `params` validator. Some local models serialize a
 * nested object as a JSON string even though the outer tool call is valid.
 */
export const CraftbookInvocationParamsArgSchema = coerceJsonObject(z.record(z.string(), z.string()))
  .optional()
  .describe(
    'Invocation parameters declared by the craftbook, such as outputPath. An input param (the files the book works on, e.g. "source") takes a folder or file path in this project workspace; prefix "artifacts:" for one in the artifacts drawer. Files outside the project cannot be passed here — ask the user to launch the craftbook from Tasks and pick them from their computer.',
  );

/**
 * Preserve a free-text job when a craftbook exposes a `topic` input but the
 * caller omitted every supported source form. The rule itself lives in core
 * (`fillMainContentParam`) so the chat composer's launch route and this
 * tool cannot disagree about it.
 */
export function inferCraftbookJobParams(args: {
  paramSchema: unknown;
  params?: Record<string, string>;
  jobDescription?: string;
}): Record<string, string> {
  return fillMainContentParam({
    paramSchema: args.paramSchema,
    ...(args.params ? { params: args.params } : {}),
    ...(args.jobDescription !== undefined ? { message: args.jobDescription } : {}),
  });
}

/** Build the concrete follow-up advertised by suggest_craftbook. */
export function suggestedCraftbookInvocation(args: {
  craftbookId: string;
  query: string;
  paramSchema?: unknown;
}): {
  craftbookId: string;
  description: string;
  params?: Record<string, string>;
} {
  const description = args.query.trim();
  const params = inferCraftbookJobParams({
    paramSchema: args.paramSchema,
    jobDescription: description,
  });
  return {
    craftbookId: args.craftbookId,
    description,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

/** Merge the convenience alias while normalizing either source of outputPath. */
export function normalizeCraftbookInvocationParams(
  params: Record<string, string> | undefined,
  outputPath: string | undefined,
): Record<string, string> {
  const merged = {
    ...(params ?? {}),
    ...(outputPath ? { outputPath } : {}),
  };
  return merged.outputPath
    ? { ...merged, outputPath: normalizeDocumentOutputPath(merged.outputPath) }
    : merged;
}

export interface BinaryDocumentCraftbookRequest {
  requestedPath: string;
  outputPath: string;
  route: BinaryDocumentCraftbookRoute | null;
}

/** Standing task brief for exact document recipes; avoids browser-build steering. */
export function buildBinaryDocumentTaskDescription(
  input: { name: string; taskDescription?: string; kickoffMessage?: string },
  request: BinaryDocumentCraftbookRequest & { route: BinaryDocumentCraftbookRoute },
): string {
  const base =
    input.taskDescription?.trim() ||
    `Create the requested ${request.route.label} deliverable for "${input.name}" at ${request.outputPath}.`;
  const note = input.kickoffMessage?.trim()
    ? `\n\nNote from the meester: ${input.kickoffMessage.trim()}`
    : '';
  return `${base}\n\nProduction route: follow the exact \`${request.route.craftbookId}\` recipe. Author its source in Markdown, then use the recipe's DocBlocks conversion, preview, and artifact-save tools. Do not replace the recipe with a hand-coded binary generator or a source-only substitute.${note}`;
}

/**
 * Resolve an explicitly named binary deliverable before start_project falls
 * back to an inline build loop. A null route is deliberate: callers must
 * block unsupported binary formats instead of assigning them to a Builder.
 */
export function binaryDocumentCraftbookRequest(input: {
  name: string;
  about: string;
  missionObjectives: string;
  taskDescription?: string;
}): BinaryDocumentCraftbookRequest | null {
  const requestedPath = inferSourceDeliverablePath(input);
  if (!requestedPath || !isBinaryDocumentOutputPath(requestedPath)) return null;
  return {
    requestedPath,
    outputPath: normalizeDocumentOutputPath(requestedPath),
    route: binaryDocumentCraftbookRoute(requestedPath),
  };
}
