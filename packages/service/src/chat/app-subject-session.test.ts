import { describe, expect, it } from 'vitest';
import { AppToolRelayRegistry } from '../app-tools/relay-registry.js';
import {
  promptAppSubjectFor,
  readAppSubjectStateLine,
  retrievalExclusionsFor,
  subjectBinding,
} from './app-subject-session.js';

const SELECTION = {
  name: 'office_read_selection',
  description: 'Read the selection.',
  inputSchema: { type: 'object', properties: {} },
};
const INSERT = {
  name: 'doc_insert_text',
  description: 'Insert text.',
  inputSchema: { type: 'object', properties: {} },
};
const SUBJECT = {
  kind: 'document' as const,
  app: 'Word',
  title: 'Untitled document',
  editable: true,
  stateTool: 'office_read_selection',
};
const SESSION = { id: 's-1', gezelId: 'marek', projectId: 'default' };

function registryWithPane(answer?: (call: { callId: string; tool: string }) => unknown) {
  const registry = new AppToolRelayRegistry();
  const { relayId } = registry.open({ appId: 'office' });
  registry.attachStream(relayId, {
    write: (event) => {
      if (event.type !== 'tool_call' || !answer) return;
      const content = answer(event);
      queueMicrotask(() =>
        registry.resolveCall(relayId, event.callId, {
          ok: true,
          content: typeof content === 'string' ? content : JSON.stringify(content),
        }),
      );
    },
  });
  registry.register(relayId, {
    projectId: 'default',
    gezelIds: ['marek'],
    surfaceId: 'pane-12345',
    subject: SUBJECT,
    tools: [SELECTION, INSERT],
  });
  registry.noteUserMessage('s-1', 'pane-12345');
  return registry;
}

describe('promptAppSubjectFor', () => {
  it('describes the live document with the tools the pane offers', () => {
    const registry = registryWithPane();
    const bindings = registry.listForSession({ ...SESSION, sessionId: 's-1' });
    expect(promptAppSubjectFor({}, bindings)).toEqual({
      focus: 'item',
      kind: 'document',
      app: 'Word',
      title: 'Untitled document',
      saved: false,
      editable: true,
      connected: true,
      toolNames: ['office_read_selection', 'doc_insert_text'],
      readsSelection: true,
    });
  });

  it('falls back to the stamp, out of reach, when the pane is not driving the thread', () => {
    const stamped = promptAppSubjectFor(
      {
        subject: {
          key: 'file:c:/report.docx',
          kind: 'document',
          app: 'Word',
          title: 'Report.docx',
        },
      },
      [],
    );
    expect(stamped).toMatchObject({ connected: false, saved: true, toolNames: [] });
    expect(promptAppSubjectFor({}, [])).toBeUndefined();
  });

  it('keeps project files out of retrieval only while the document is the job', () => {
    const registry = registryWithPane();
    const live = promptAppSubjectFor({}, registry.listForSession({ ...SESSION, sessionId: 's-1' }));
    expect(retrievalExclusionsFor(live)).toEqual(['workspace', 'artifacts']);
    expect(retrievalExclusionsFor({ ...live!, connected: false })).toEqual([]);
    expect(retrievalExclusionsFor({ ...live!, focus: 'context' })).toEqual([]);
    expect(retrievalExclusionsFor(undefined)).toEqual([]);
  });
});

describe('readAppSubjectStateLine', () => {
  it('opens the turn with what the person has selected', async () => {
    const registry = registryWithPane((call) => {
      expect(call.tool).toBe('office_read_selection');
      return { isEmpty: false, text: 'Gezel keeps everything on your disk.' };
    });
    const binding = subjectBinding(registry.listForSession({ ...SESSION, sessionId: 's-1' }))!;
    const line = await readAppSubjectStateLine({ registry, binding, session: SESSION });
    expect(line).toContain('[Word, "Untitled document": the person has selected this text.');
    expect(line).toContain('Gezel keeps everything on your disk.');
  });

  it('goes without the line when the pane does not answer in time', async () => {
    const registry = registryWithPane();
    const binding = subjectBinding(registry.listForSession({ ...SESSION, sessionId: 's-1' }))!;
    const line = await readAppSubjectStateLine({
      registry,
      binding,
      session: SESSION,
      timeoutMs: 20,
    });
    expect(line).toBeNull();
  });
});
