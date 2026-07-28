/**
 * `turn.permission-stall` - catches local models asking "should I
 * proceed?" after the user already gave an action request. This is a
 * different failure from fabrication: the model often has just read the
 * right files, or even landed one edit, then parks the turn behind a
 * prose permission question instead of taking the next action.
 */

import type { Behavior, NudgeVerdict, TurnCtx } from '../types.js';

const PERMISSION_STALL_PATTERN =
  /\b(?:should\s+i|shall\s+i|would\s+you\s+like\s+me\s+to|do\s+you\s+want\s+me\s+to|can\s+i|may\s+i)\s+(?:proceed|continue|go\s+ahead|start|begin|make|apply|implement|add|fix|update|patch|rewrite|try|delegate|hand\s+off)\b/i;

const ACTION_REQUEST_PATTERN =
  /\b(?:fix|repair|debug|write|create|build|implement|update|modify|edit|add|patch|rewrite|finish|continue|keep\s+going|do\s+the\s+next\s+thing|ship|make)\b/i;

const ACTION_TOOL_PREFIXES = ['write', 'replace', 'append', 'apply', 'insert', 'run', 'delegate'];
const ACTION_TOOL_NAMES = new Set([
  'make_dir',
  'rename',
  'delete_path',
  'npm_install',
  'create_task',
  'assign_task',
  'advance_task_step',
  'set_task_status',
]);

function usedActionOrInvestigationTool(ctx: TurnCtx): boolean {
  return ctx.drained.some((call) => {
    if (call.name === 'ask_user_question') return false;
    if (call.name === 'read_file' || call.name === 'list_dir' || call.name === 'search_code') {
      return true;
    }
    if (ACTION_TOOL_NAMES.has(call.name)) return true;
    return ACTION_TOOL_PREFIXES.some((prefix) => call.name.startsWith(prefix));
  });
}

function detect(ctx: TurnCtx): NudgeVerdict | null {
  if (!PERMISSION_STALL_PATTERN.test(ctx.assistantContent)) return null;
  if (ctx.drained.some((call) => call.success && call.name === 'ask_user_question')) return null;
  if (!ACTION_REQUEST_PATTERN.test(ctx.userText) && !usedActionOrInvestigationTool(ctx))
    return null;

  return {
    reason: 'asked for prose permission after an action request instead of taking the next step',
    promptForNextTurn: [
      'The user already asked you to do the work. Do not ask "should I proceed" or "would you like me to" in prose.',
      'If a real human decision is required, call `ask_user_question`. Otherwise, continue now with an action tool call.',
      'For code edits, use the current file state: read the file if line numbers are stale, then call `replace_lines` for the smallest parseable range, or `write_file` only for a complete new/rewrite file.',
      'Keep visible prose short after the tool result.',
    ].join('\n'),
  };
}

export const TurnPermissionStall: Behavior = {
  id: 'turn.permission-stall',
  description:
    'Re-prompts when a local model asks for prose permission to proceed after the user already gave an action request.',
  postTurnDetector: (ctx) => detect(ctx),
};
