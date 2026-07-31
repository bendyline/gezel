import type { McpServerSpec } from '../mcp-bridge.js';
import { isGezelMcp } from './gezel-mcp-small-model.js';
import type { McpToolWrapper } from './types.js';

/**
 * Older prompts and model priors sometimes call task-step tools with
 * `{ id: "build" }`; the current contract names that field `stepId`.
 * Normalize the unambiguous legacy spelling before Zod validation so a
 * harmless schema drift does not stop an otherwise-valid workflow.
 */
const STEP_ID_TOOLS = new Set(['write_task_note', 'read_task_notes', 'advance_task_step']);

export const TaskStepArgNormalizer: McpToolWrapper = {
  id: 'task-step-arg-normalizer',
  matches(spec: McpServerSpec): boolean {
    return isGezelMcp(spec);
  },
  async preProcess(toolName, args) {
    if (!STEP_ID_TOOLS.has(toolName) || typeof args.id !== 'string') {
      return { kind: 'allow' };
    }
    const next = { ...args };
    if (next.stepId === undefined) next.stepId = next.id;
    delete next.id;
    return { kind: 'allow', args: next };
  },
};
