import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEventEnvelope } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { ChatEventBus } from './events.js';
import {
  ExternalConversationRecorder,
  type ExternalTranscriptMessage,
} from './external-conversation-recorder.js';

let home: string;
let store: Store;
let events: ChatEventBus;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-external-chat-'));
  store = new Store({ home });
  events = new ChatEventBus();
  await store.ensureLayout();
  await store.createGezel({ name: 'Sipho', role: 'Developer' });
  await store.createProject({ name: 'Default' });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function beginInput(messages: ExternalTranscriptMessage[], workingDirectory?: string) {
  return {
    sourceId: 'pi',
    sourceName: 'Pi',
    externalConversationId: 'pi-session-123',
    ...(workingDirectory ? { workingDirectory } : {}),
    gezelId: 'sipho',
    providerName: 'mlx' as const,
    model: 'qwen-test',
    messages,
    effectiveSystemMessage: 'You are Pi through Gezel.',
    toolNames: ['readFile', 'write'],
  };
}

describe('ExternalConversationRecorder', () => {
  it('attaches a Pi chat to the one project whose working directory matches', async () => {
    const workdir = join(home, 'race-game');
    await mkdir(workdir);
    const project = await store.createProject({ name: 'Race game', workingDir: workdir });
    const recorder = new ExternalConversationRecorder({ store, events });

    const turn = await recorder.begin(
      beginInput([{ role: 'user', content: 'Build a rally game.' }], `${workdir}/`),
    );

    expect(turn.projectId).toBe(project.id);
    const record = await store.getSession('sipho', turn.sessionId);
    const canonicalWorkdir = await realpath(workdir);
    expect(record).toMatchObject({
      projectId: project.id,
      source: {
        kind: 'external',
        appId: 'pi',
        appName: 'Pi',
        externalConversationId: 'pi-session-123',
        readOnly: true,
        workingDirectory:
          process.platform === 'win32' ? canonicalWorkdir.toLowerCase() : canonicalWorkdir,
      },
    });
    expect((await store.listSessions({ gezelId: 'sipho' }))[0]?.source?.appName).toBe('Pi');
    expect(
      (await store.listTimeline({ projectId: project.id, limit: 20 })).messages[0]?.sessionSource
        ?.appName,
    ).toBe('Pi');
  });

  it('uses the default project when no project matches or several projects match', async () => {
    const unmatched = join(home, 'unmatched');
    const shared = join(home, 'shared');
    await Promise.all([mkdir(unmatched), mkdir(shared)]);
    await store.createProject({ name: 'Shared one', workingDir: shared });
    await store.createProject({ name: 'Shared two', workingDir: shared });

    const noMatch = new ExternalConversationRecorder({ store, events });
    const noMatchTurn = await noMatch.begin(
      beginInput([{ role: 'user', content: 'Hello.' }], unmatched),
    );
    expect(noMatchTurn.projectId).toBe('default');

    const ambiguous = new ExternalConversationRecorder({ store, events });
    const ambiguousTurn = await ambiguous.begin({
      ...beginInput([{ role: 'user', content: 'Hello again.' }], shared),
      externalConversationId: 'pi-session-ambiguous',
    });
    expect(ambiguousTurn.projectId).toBe('default');
  });

  it('accepts one exact project id/name hint without guessing between duplicate names', async () => {
    const project = await store.createProject({ name: 'Racing game' });
    await store.createProject({ name: 'Duplicate name' });
    await store.createProject({ name: 'Duplicate name' });
    const recorder = new ExternalConversationRecorder({ store, events });

    const exact = await recorder.begin({
      ...beginInput([{ role: 'user', content: 'Build it.' }]),
      externalConversationId: 'pi-project-hint',
      projectHint: project.id,
    });
    expect(exact.projectId).toBe(project.id);

    const ambiguous = await recorder.begin({
      ...beginInput([{ role: 'user', content: 'Do not guess.' }]),
      externalConversationId: 'pi-project-ambiguous',
      projectHint: 'Duplicate name',
    });
    expect(ambiguous.projectId).toBe('default');
  });

  it('reconciles full Pi transcripts idempotently and closes only the final turn', async () => {
    const onFinalTurn = vi.fn();
    const recorder = new ExternalConversationRecorder({ store, events, onFinalTurn });
    const envelopes: ChatEventEnvelope[] = [];
    events.subscribeAll((envelope) => envelopes.push(envelope));

    const initial = await recorder.begin(
      beginInput([{ role: 'user', content: 'Inspect the project.' }]),
    );
    expect(recorder.listActive()).toEqual([
      expect.objectContaining({
        sessionId: initial.sessionId,
        gezelId: 'sipho',
        projectId: 'default',
        userText: 'Inspect the project.',
      }),
    ]);
    initial.onReasoningDelta('First reasoning chunk. ');
    await initial.finish({ content: '', finishReason: 'tool_calls' });
    expect(recorder.listActive()).toHaveLength(1);
    expect(onFinalTurn).not.toHaveBeenCalled();
    expect(envelopes.filter((envelope) => envelope.event.type === 'complete')).toHaveLength(0);
    expect(envelopes.filter((envelope) => envelope.event.type === 'done')).toHaveLength(0);

    const withToolResult: ExternalTranscriptMessage[] = [
      { role: 'user', content: 'Inspect the project.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'readFile', arguments: '{"path":"index.html"}' }],
      },
      { role: 'tool', content: '<html>hello</html>', toolCallId: 'call-1' },
    ];
    const continuation = await recorder.begin(beginInput(withToolResult));
    continuation.onReasoningDelta('Second reasoning chunk.');
    await continuation.finish({ content: '', finishReason: 'tool_calls' });
    // Reconciled tools join the same live turn. Neither the tool-call finish
    // nor the tool-bearing transcript message clears the reasoning slot.
    expect(envelopes.filter((envelope) => envelope.event.type === 'tool')).toHaveLength(1);
    expect(envelopes.filter((envelope) => envelope.event.type === 'complete')).toHaveLength(0);
    expect(
      envelopes
        .filter((envelope) => envelope.event.type === 'reasoning_delta')
        .map((envelope) =>
          envelope.event.type === 'reasoning_delta' ? envelope.event.content : '',
        )
        .join(''),
    ).toBe('First reasoning chunk. \n\nSecond reasoning chunk.');

    const finalTurn = await recorder.begin(beginInput(withToolResult));

    let record = await store.getSession('sipho', finalTurn.sessionId);
    // Tool rounds remain part of the live assistant card and do not become
    // durable placeholder bubbles while the caller-owned loop is still open.
    expect(record?.messages).toHaveLength(1);
    finalTurn.onReasoningDelta('Checked the file.');

    await finalTurn.finish({
      content: 'The page is intact.',
      reasoning: 'Checked the file.',
      finishReason: 'stop',
    });
    record = await store.getSession('sipho', finalTurn.sessionId);
    expect(record?.messages).toHaveLength(2);
    expect(record?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'The page is intact.',
      reasoning: 'First reasoning chunk. \n\nSecond reasoning chunk.\n\nChecked the file.',
      toolCalls: [
        expect.objectContaining({
          name: 'readFile',
          success: true,
          resultText: '<html>hello</html>',
        }),
      ],
    });
    expect(onFinalTurn).toHaveBeenCalledOnce();
    expect(envelopes.filter((envelope) => envelope.event.type === 'done')).toHaveLength(1);
    expect(recorder.listActive()).toHaveLength(0);
  });

  it('coalesces several Pi tool iterations into one final assistant message', async () => {
    const recorder = new ExternalConversationRecorder({ store, events });
    const envelopes: ChatEventEnvelope[] = [];
    events.subscribeAll((envelope) => envelopes.push(envelope));

    const first = await recorder.begin(beginInput([{ role: 'user', content: 'Build it.' }]));
    first.onContentDelta('I will inspect the folder.');
    await first.finish({ content: 'I will inspect the folder.', finishReason: 'tool_calls' });

    const afterFirstTool: ExternalTranscriptMessage[] = [
      { role: 'user', content: 'Build it.' },
      {
        role: 'assistant',
        content: 'I will inspect the folder.',
        toolCalls: [{ id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }],
      },
      { role: 'tool', content: '', toolCallId: 'call-1' },
    ];
    const second = await recorder.begin(beginInput(afterFirstTool));
    second.onContentDelta('Now I will write the game.');
    await second.finish({ content: 'Now I will write the game.', finishReason: 'tool_calls' });

    const afterSecondTool: ExternalTranscriptMessage[] = [
      ...afterFirstTool,
      {
        role: 'assistant',
        content: 'Now I will write the game.',
        toolCalls: [
          { id: 'call-2', name: 'write', arguments: '{"path":"game.js","content":"..."}' },
        ],
      },
      { role: 'tool', content: 'wrote game.js', toolCallId: 'call-2' },
    ];
    const final = await recorder.begin(beginInput(afterSecondTool));

    expect((await store.getSession('sipho', final.sessionId))?.messages).toHaveLength(1);
    expect(envelopes.filter((envelope) => envelope.event.type === 'tool')).toHaveLength(2);
    expect(envelopes.filter((envelope) => envelope.event.type === 'complete')).toHaveLength(0);

    await final.finish({ content: 'The game is ready.', finishReason: 'stop' });
    const record = await store.getSession('sipho', final.sessionId);
    expect(record?.messages).toHaveLength(2);
    expect(record?.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'I will inspect the folder.\n\nNow I will write the game.\n\nThe game is ready.',
    });
    expect(record?.messages[1]?.toolCalls).toHaveLength(2);
    expect(envelopes.filter((envelope) => envelope.event.type === 'complete')).toHaveLength(1);
    expect(envelopes.filter((envelope) => envelope.event.type === 'done')).toHaveLength(1);
  });

  it('persists the actual caller request and does not mark explicit tool errors successful', async () => {
    const recorder = new ExternalConversationRecorder({ store, events });
    const turn = await recorder.begin({
      ...beginInput([
        { role: 'system', content: 'Caller-owned system prompt.' },
        { role: 'user', content: 'Write index.html.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-write', name: 'write', arguments: '{"path":"index.html"}' }],
        },
        { role: 'tool', content: 'Error: permission denied', toolCallId: 'call-write' },
      ]),
      effectiveSystemMessage: 'Gezel persona.\n\nCaller-owned system prompt.',
      toolNames: ['write'],
      actionLedger: '[Gezel caller-owned action ledger]\n- write -> "index.html"',
    });

    await turn.finish({ content: 'I could not write the file.', finishReason: 'stop' });
    const record = await store.getSession('sipho', turn.sessionId);
    expect(record?.externalRequestDiagnostics).toMatchObject({
      systemMessage: 'Gezel persona.\n\nCaller-owned system prompt.',
      toolNames: ['write'],
      messageCount: 4,
      actionLedger: '[Gezel caller-owned action ledger]\n- write -> "index.html"',
    });
    expect(record?.externalRequestDiagnostics?.transcript.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'call-write',
      content: 'Error: permission denied',
    });
    expect(record?.messages.at(-1)?.toolCalls?.[0]).toMatchObject({
      name: 'write',
      success: false,
      errorMessage: 'Error: permission denied',
    });
  });
});
