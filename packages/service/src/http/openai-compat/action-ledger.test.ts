import { describe, expect, it } from 'vitest';
import { appendCallerOwnedActionLedger } from './action-ledger.js';
import type { TranslatedSessionInput } from './translate.js';

const input = (priorMessages: TranslatedSessionInput['priorMessages']): TranslatedSessionInput => ({
  systemMessage: 'system',
  prompt: '',
  priorMessages,
  attachments: [],
});

describe('appendCallerOwnedActionLedger', () => {
  it('records only completed structured file mutations in the current user turn', () => {
    const result = appendCallerOwnedActionLedger(
      input([
        { role: 'user', content: 'Build the page.' },
        {
          role: 'assistant',
          content: 'I will write three files.',
          toolCalls: [
            {
              id: 'call-html',
              name: 'write',
              arguments: '{"filePath":"/tmp/site/index.html","content":"<html>"}',
            },
          ],
        },
        { role: 'tool', toolCallId: 'call-html', content: 'Wrote file successfully.' },
      ]),
    );

    expect(result.receiptCount).toBe(1);
    expect(result.ledger).toContain('write (call-html) -> "/tmp/site/index.html"');
    expect(result.ledger).toContain('Planned or narrated actions are not receipts');
    expect(result.input.priorMessages.at(-1)?.content).toContain(
      '[Gezel caller-owned action ledger]',
    );
    expect(result.input.priorMessages.at(-1)?.content).not.toContain('css/style.css');
  });

  it('rolls up multiple returned mutations and excludes shell calls', () => {
    const result = appendCallerOwnedActionLedger(
      input([
        { role: 'user', content: 'Build it.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-shell', name: 'bash', arguments: '{"command":"mkdir -p js"}' },
            { id: 'call-write', name: 'write_file', arguments: '{"path":"js/app.js"}' },
          ],
        },
        { role: 'tool', toolCallId: 'call-shell', content: 'ok' },
        { role: 'tool', toolCallId: 'call-write', content: 'ok' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call-rename',
              name: 'rename',
              arguments: '{"oldPath":"js/app.js","newPath":"js/main.js"}',
            },
          ],
        },
        { role: 'tool', toolCallId: 'call-rename', content: 'ok' },
      ]),
    );

    expect(result.receiptCount).toBe(2);
    expect(result.ledger).toContain('"js/app.js"');
    expect(result.ledger).toContain('"js/main.js"');
    expect(result.ledger).not.toContain('call-shell');
    expect(result.ledger).toContain('Shell-command side effects are not enumerated');
  });

  it('does not alter ordinary user turns or read-only tool results', () => {
    const userTurn = input([{ role: 'user', content: 'Hello' }]);
    expect(appendCallerOwnedActionLedger(userTurn)).toEqual({ input: userTurn, receiptCount: 0 });

    const readTurn = input([
      { role: 'user', content: 'Read it.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-read', name: 'readFile', arguments: '{"path":"a.txt"}' }],
      },
      { role: 'tool', toolCallId: 'call-read', content: 'hello' },
    ]);
    expect(appendCallerOwnedActionLedger(readTurn)).toEqual({
      input: readTurn,
      receiptCount: 0,
    });
  });
});
