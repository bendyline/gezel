import type { SessionDebugSnapshot } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { formatDebugBundle } from './chat-bubbles.js';

function snapshot(partial: Partial<SessionDebugSnapshot> = {}): SessionDebugSnapshot {
  return {
    sessionId: 's1',
    providerName: 'llama-cpp',
    modelTier: 'medium',
    leaksUntaggedReasoning: true,
    systemPrompt: '## Tools available this turn\n`read_file`, `write_task_note`',
    customToolsMd: false,
    registeredTools: [],
    turnStatus: 'idle',
    recentMessages: [],
    generatedAt: '2026-08-16T22:10:24.459Z',
    ...partial,
  } as SessionDebugSnapshot;
}

const render = (partial: Partial<SessionDebugSnapshot>): string =>
  formatDebugBundle({ snapshot: snapshot(partial), response: 'hi' });

describe('formatDebugBundle — registered tools line', () => {
  it('never claims "none" for a cold snapshot that asked no bridge', () => {
    // The wild-caught misdirection: an aborted turn exported a bundle
    // reading "Registered tools: none (cold session, or MCP bridge not
    // yet started)" while the same bundle's prompt listed ~80 wired
    // tools. An investigation went looking for a dropped bridge.
    const out = render({ registeredToolsSource: 'unavailable' });
    expect(out).toContain('not recorded');
    expect(out).toContain('NOT an empty roster');
    expect(out).not.toMatch(/Registered tools: \*\*none\*\*/);
  });

  it('falls back to the safe wording for snapshots predating the source field', () => {
    // Older persisted bundles carry no source. Absence of evidence must
    // not render as evidence of absence.
    const out = render({});
    expect(out).toContain('not recorded');
    expect(out).not.toMatch(/Registered tools: \*\*none\*\*/);
  });

  it('says "none" only when a live session actually reported an empty bridge', () => {
    const out = render({ registeredToolsSource: 'live' });
    expect(out).toContain('Registered tools: **none**');
    expect(out).toContain('live session reported an empty bridge');
  });

  it('lists the tools, and marks a persisted list as last-known', () => {
    const live = render({
      registeredTools: ['read_file', 'write_task_note'],
      registeredToolsSource: 'live',
    });
    expect(live).toContain('Registered tools (2): `read_file`, `write_task_note`');
    expect(live).not.toContain('last known');

    const persisted = render({
      registeredTools: ['get_board'],
      registeredToolsSource: 'persisted',
    });
    expect(persisted).toContain('Registered tools (1, last known): `get_board`');
  });

  it('labels captured external evidence without presenting a native reconstruction as fact', () => {
    const out = render({
      systemPrompt: 'Actual OpenCode system prompt',
      registeredTools: ['write', 'read'],
      registeredToolsSource: 'caller',
      externalConversation: {
        appId: 'opencode',
        appName: 'OpenCode',
        externalConversationId: 'oc-1',
        workingDirectory: '/tmp/site',
        request: {
          capturedAt: '2026-08-18T13:00:00.000Z',
          systemMessage: 'Actual OpenCode system prompt',
          toolNames: ['write', 'read'],
          messageCount: 3,
          transcript: [
            { role: 'user', content: 'Build it.' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'write', arguments: '{"path":"index.html"}' }],
            },
            { role: 'tool', content: 'ok', toolCallId: 'call-1' },
          ],
          actionLedger: '[Gezel caller-owned action ledger]\n- write -> `index.html`',
        },
      },
      diagnostics: {
        sessionRecordPath: '/tmp/session.json',
        logsDir: '/tmp/logs',
      },
    });

    expect(out).toContain('Conversation owner: **OpenCode**');
    expect(out).toContain('Registered tools (2, supplied by OpenCode)');
    expect(out).toContain('System prompt (captured from OpenCode request)');
    expect(out).not.toContain('System prompt (freshly computed)');
    expect(out).toContain('Caller-owned request transcript (3 of 3 messages)');
    expect(out).toContain('Tool call `write` (`call-1`) arguments');
    expect(out).toContain('Action ledger injected into the completion');
    expect(out).toContain('Gezel mirror record');
  });
});
