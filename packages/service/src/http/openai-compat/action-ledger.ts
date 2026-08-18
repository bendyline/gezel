import type { TranslatedSessionInput } from './translate.js';

const LEDGER_HEADING = '[Gezel caller-owned action ledger]';
const MAX_PATHS = 12;

export interface CallerOwnedActionLedgerResult {
  input: TranslatedSessionInput;
  /** Empty when this is not a tool-result continuation with file mutations. */
  ledger?: string;
  receiptCount: number;
}

type PriorMessage = TranslatedSessionInput['priorMessages'][number];
type ToolCall = { id: string; name: string; arguments: string };

/**
 * Attach a compact, transcript-derived file-action receipt to the final tool
 * result in a caller-owned loop. The receipt deliberately describes only
 * structured calls for which the caller supplied a result. It does not infer
 * filesystem state, promote assistant narration into action, or enumerate
 * opaque shell-command side effects.
 */
export function appendCallerOwnedActionLedger(
  input: TranslatedSessionInput,
): CallerOwnedActionLedgerResult {
  const last = input.priorMessages.at(-1);
  if (!last || last.role !== 'tool') return { input, receiptCount: 0 };

  let latestUserIndex = -1;
  for (let index = input.priorMessages.length - 1; index >= 0; index -= 1) {
    if (input.priorMessages[index]?.role === 'user') {
      latestUserIndex = index;
      break;
    }
  }

  const calls = new Map<string, ToolCall>();
  const completed = new Set<string>();
  for (let index = latestUserIndex + 1; index < input.priorMessages.length; index += 1) {
    const message = input.priorMessages[index]!;
    if (message.role === 'assistant' && 'toolCalls' in message) {
      for (const call of message.toolCalls) calls.set(call.id, call);
    } else if (message.role === 'tool') {
      completed.add(message.toolCallId);
    }
  }

  const receipts: Array<{ call: ToolCall; paths: string[] }> = [];
  for (const [id, call] of calls) {
    if (!completed.has(id) || !isStructuredFileMutation(call.name)) continue;
    receipts.push({ call, paths: extractPathArguments(call.arguments) });
  }
  if (receipts.length === 0) return { input, receiptCount: 0 };

  const lines = [
    LEDGER_HEADING,
    'The caller returned a result for these structured file-mutation calls in the current user turn:',
  ];
  for (const { call, paths } of receipts) {
    const target =
      paths.length > 0
        ? paths.map((path) => JSON.stringify(path)).join(', ')
        : '(target not present in structured arguments)';
    lines.push(`- ${call.name} (${call.id}) -> ${target}`);
  }
  lines.push(
    'Each result confirms only that its matching call returned; use the result text to determine success or failure.',
    'Planned or narrated actions are not receipts. Shell-command side effects are not enumerated here; inspect files when they matter.',
    'Before claiming completion, compare the requested files with these receipts and make additional tool calls for anything not yet covered.',
  );
  const ledger = lines.join('\n');
  const priorMessages = input.priorMessages.map((message, index): PriorMessage => {
    if (index !== input.priorMessages.length - 1 || message.role !== 'tool') return message;
    if (message.content.includes(LEDGER_HEADING)) return message;
    return {
      ...message,
      content: message.content ? `${message.content}\n\n${ledger}` : ledger,
    };
  });

  return { input: { ...input, priorMessages }, ledger, receiptCount: receipts.length };
}

function isStructuredFileMutation(name: string): boolean {
  const normalized = name
    .split(/[.:/]/u)
    .at(-1)!
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '');
  return (
    /(?:write|edit|patch|replace|append|rename|move|copy|delete|remove|unlink|mkdir|touch)/u.test(
      normalized,
    ) || normalized === 'rm'
  );
}

function extractPathArguments(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const pathKeys = new Set([
    'path',
    'filepath',
    'filename',
    'targetpath',
    'destination',
    'dest',
    'sourcepath',
    'oldpath',
    'newpath',
    'directory',
    'dir',
    'from',
    'to',
  ]);
  const paths: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 3 || paths.length >= MAX_PATHS) return;
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/gu, '');
      if (
        pathKeys.has(normalizedKey) &&
        typeof nested === 'string' &&
        nested.length > 0 &&
        nested.length <= 4096
      ) {
        paths.push(nested);
      } else if (typeof nested === 'object') {
        visit(nested, depth + 1);
      }
      if (paths.length >= MAX_PATHS) break;
    }
  };
  visit(parsed, 0);
  return [...new Set(paths)];
}
