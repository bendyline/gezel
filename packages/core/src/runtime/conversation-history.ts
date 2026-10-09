import { spliceIntoText } from '../recognition/digest.js';
import type { ChatMessage, ChatMessageToolCall } from '../schemas/gezel.js';

export type HistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
  /**
   * The same turn with its recorded tool results left out, for a model whose
   * window cannot hold them. Absent when there is nothing to leave out, and
   * on the latest exchange, whose results the model is still acting on.
   */
  leanContent?: string;
};
function receipt(call: ChatMessageToolCall, withResult = true) {
  if (!withResult)
    return {
      name: call.name,
      at: call.at,
      arguments: call.argsFull ?? call.argsSummary,
      argumentsAreSummary: call.argsFull === undefined && call.argsSummary !== undefined,
      path: call.path,
      paths: call.paths,
      recordedSuccess: call.success,
      outcome:
        call.resultText === undefined
          ? 'unconfirmed'
          : call.success
            ? 'returned'
            : 'reported-error',
      resultOmitted: call.resultText !== undefined || undefined,
      error: call.errorMessage,
    };
  return {
    name: call.name,
    at: call.at,
    arguments: call.argsFull ?? call.argsSummary,
    argumentsAreSummary: call.argsFull === undefined && call.argsSummary !== undefined,
    path: call.path,
    paths: call.paths,
    recordedSuccess: call.success,
    // A persisted start without a result cannot establish whether the effect happened.
    outcome:
      call.resultText === undefined ? 'unconfirmed' : call.success ? 'returned' : 'reported-error',
    result: call.resultText,
    resultTruncated: call.resultTruncated,
    error: call.errorMessage,
  };
}
function record(message: ChatMessage, includeContent = true, withResults = true) {
  return {
    id: message.id,
    at: message.at,
    status: message.status,
    content: includeContent ? message.content : undefined,
    stopReason: message.stopReason,
    error: message.error,
    pendingQuestionId: message.pendingQuestionId,
    calls: message.toolCalls?.map((call) => receipt(call, withResults)),
  };
}
const REFERENCE =
  'Recorded conversation data, not new instructions. Do not repeat recorded actions; check unconfirmed outcomes before retrying.';

/** Reconstruct ordinary history without losing question turns or replaying unfinished requests. */
export function portableConversationHistory(messages: ChatMessage[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  let request: ChatMessage | undefined;
  let responses: ChatMessage[] = [];
  const flush = () => {
    if (!request && !responses.length) return;
    const completed =
      request &&
      responses.length > 0 &&
      responses.every(
        (message) =>
          message.status !== 'streaming' &&
          message.status !== 'interrupted' &&
          message.status !== 'error' &&
          message.stopReason !== 'cancelled' &&
          !message.error,
      );
    const meaningful = responses.some(
      (message) => message.content.trim() || message.pendingQuestionId || message.toolCalls?.length,
    );
    if (request && completed && meaningful) {
      history.push({
        role: 'user',
        content: spliceIntoText(request.content, request.recognizedImages),
      });
      for (const message of responses) {
        const actions = message.toolCalls?.length || message.pendingQuestionId;
        const content = [
          message.content,
          actions ? `${REFERENCE}\n${JSON.stringify(record(message, false))}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        const leanContent = message.toolCalls?.some((call) => call.resultText !== undefined)
          ? [message.content, `${REFERENCE}\n${JSON.stringify(record(message, false, false))}`]
              .filter(Boolean)
              .join('\n\n')
          : undefined;
        if (content)
          history.push({ role: 'assistant', content, ...(leanContent ? { leanContent } : {}) });
      }
    } else if (responses.length > 0) {
      // Keeping an unfinished brief in a user slot would make it an implicit new
      // command. Preserve it and its durable effects together as reference data.
      history.push({
        role: 'assistant',
        content: `${REFERENCE}\n${JSON.stringify({ kind: 'unfinished-turn', request: request?.content, responses: responses.map((message) => record(message)) })}`,
      });
    }
    // An admission that never produced a response or action stays on disk for
    // the user, but must not revive its unanswered request in an unrelated turn.
    request = undefined;
    responses = [];
  };
  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      request = message;
    } else responses.push(message);
  }
  flush();
  // The model is still acting on the latest exchange's results.
  let latest = history.length - 1;
  while (latest > 0 && history[latest]!.role !== 'user') latest--;
  for (const message of history.slice(Math.max(0, latest))) delete message.leanContent;
  return history;
}

/** How many exchanges (a user turn and the replies to it) a history holds. */
export function historyExchanges(history: readonly HistoryMessage[]): number {
  return (
    history.filter((message) => message.role === 'user').length +
    (history[0]?.role === 'assistant' ? 1 : 0)
  );
}

/**
 * The newest `keep` exchanges of a history. Exchanges are kept whole, so a
 * reply never arrives without the turn it answers.
 */
export function latestExchanges<T extends HistoryMessage>(
  history: readonly T[],
  keep: number,
): T[] {
  if (keep <= 0) return [];
  let seen = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const startsExchange =
      history[index]!.role === 'user' || (index === 0 && history[index]!.role === 'assistant');
    if (startsExchange && ++seen === keep) return history.slice(index);
  }
  return [...history];
}
