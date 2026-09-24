import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LlamaCppProvider,
  isLlamaServerOutputFormatRejection,
  llamaServerStreamErrorMessage,
  missingFileEditRecoveryPath,
  widenWireToolSurface,
} from './provider.js';

/**
 * gemma4-31b-q4 / schema-migration (llama.cpp v0.4.1, 2026-09-23). A repair
 * turn meant to create the missing `tests/migrate.test.ts` lost a complete,
 * correct `write_file` three turns running:
 *
 *   1. `replace_lines` on the missing file answered a bare `not found`, which
 *      did not open the missing-file create path;
 *   2. two failed patches escalated to a read_file-only refresh surface;
 *   3. the model answered it with `write_file` anyway, then rambled to the
 *      4096-token cap. llama-server's peg-gemma4 parser builds its tool-name
 *      alternation from the request's `tools`, so the final parse threw and
 *      the whole generation was replaced by one `{"error":…}` frame — which
 *      the stream pump skipped, reporting "no mutation" instead.
 */

type WireBody = {
  messages: Array<{ role: string; content: string | null }>;
  tools?: Array<{ function: { name: string } }>;
};

function sseResponse(events: Array<unknown>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const ev of events) {
        const payload = ev === '[DONE]' ? '[DONE]' : JSON.stringify(ev);
        ctrl.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      ctrl.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function toolCallResponse(id: string, name: string, args: Record<string, unknown>): Response {
  return sseResponse([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]);
}

async function sessionWithRoster(
  roster: readonly string[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
) {
  const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
  const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
  const internal = session as unknown as {
    deps: {
      bridges: {
        isEmpty: () => boolean;
        getOpenAITools: () => Array<{
          name: string;
          description: string;
          parameters: Record<string, unknown>;
        }>;
        hasTool: (name: string) => boolean;
        callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
      };
    };
  };
  internal.deps.bridges = {
    isEmpty: () => false,
    getOpenAITools: () =>
      roster.map((name) => ({ name, description: `${name} tool`, parameters: { type: 'object' } })),
    hasTool: (name: string) => roster.includes(name),
    callTool,
  };
  const warnings: string[] = [];
  session.onWarning?.((msg) => warnings.push(msg));
  return { session, warnings };
}

const wireNames = (body: WireBody | undefined) =>
  body?.tools?.map((entry) => entry.function.name).sort() ?? [];

// Verbatim frame: llama-server's final parse throws and sends only this.
const PEG_REJECTION = {
  error: {
    code: 500,
    message: 'The model produced output that does not match the expected peg-gemma4 format',
    type: 'server_error',
  },
};
const DISCARD_WARNING = "rejected the model's output as unparseable";

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('llama-server in-stream error frames', () => {
  it('reads the message off an error frame and ignores ordinary chunks', () => {
    expect(llamaServerStreamErrorMessage(PEG_REJECTION)).toBe(PEG_REJECTION.error.message);
    expect(llamaServerStreamErrorMessage({ error: 'slot unavailable' })).toBe('slot unavailable');
    expect(llamaServerStreamErrorMessage({ error: { code: 500 } })).toBe('unknown stream error');
    expect(
      llamaServerStreamErrorMessage({ choices: [{ index: 0, delta: { content: 'hi' } }] }),
    ).toBeNull();
    expect(llamaServerStreamErrorMessage('[DONE]')).toBeNull();
    expect(llamaServerStreamErrorMessage(null)).toBeNull();
  });

  it('recognizes the chat-format parser rejection for any PEG format', () => {
    expect(isLlamaServerOutputFormatRejection(PEG_REJECTION.error.message)).toBe(true);
    expect(
      isLlamaServerOutputFormatRejection(
        'The model produced output that does not match the expected peg-native format',
      ),
    ).toBe(true);
    expect(isLlamaServerOutputFormatRejection('Failed to parse tool call arguments as JSON')).toBe(
      false,
    );
  });

  it('widens a narrowed wire surface with exactly the tools it withheld', () => {
    const t = (name: string) => ({ function: { name, marker: `${name}-schema` } });
    const pinnedRead = { function: { name: 'read_file', marker: 'path-pinned' } };
    const full = [t('read_file'), t('write_file'), t('validate')];
    expect(widenWireToolSurface([pinnedRead], full)).toEqual([
      pinnedRead,
      t('write_file'),
      t('validate'),
    ]);
    expect(widenWireToolSurface(full, full)).toBeNull();
    expect(widenWireToolSurface(undefined, full)).toBeNull();
  });
});

describe('missingFileEditRecoveryPath', () => {
  it('treats the bare `not found` of a 404 pre-edit read as a missing target', () => {
    const args = { path: ' tests/migrate.test.ts ' };
    expect(missingFileEditRecoveryPath('replace_lines', args, 'not found')).toBe(
      'tests/migrate.test.ts',
    );
    expect(missingFileEditRecoveryPath('replace_in_file', args, 'ERROR: Not found.')).toBe(
      'tests/migrate.test.ts',
    );
  });

  it('keeps an anchor miss on an existing file a patch retry', () => {
    const args = { path: 'src/controller.ts' };
    expect(
      missingFileEditRecoveryPath(
        'replace_in_file',
        args,
        '`find` string was not found in src/controller.ts',
      ),
    ).toBeNull();
    expect(
      missingFileEditRecoveryPath(
        'replace_in_file',
        args,
        'ERROR: pattern not found in src/controller.ts',
      ),
    ).toBeNull();
    expect(missingFileEditRecoveryPath('read_file', args, 'not found')).toBeNull();
  });
});

describe('scenario repair against a missing target', () => {
  it('treats a bare `not found` from a surgical edit as a missing file to create', async () => {
    const bodies: WireBody[] = [];
    let created = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as WireBody);
      return bodies.length === 1
        ? toolCallResponse('call_patch', 'replace_lines', {
            path: 'tests/migrate.test.ts',
            startLine: 1,
            endLine: 100,
            content: 'test();',
          })
        : toolCallResponse('call_create', 'write_file', {
            path: 'tests/migrate.test.ts',
            content: "test('migration', () => {});\n",
          });
    }) as typeof fetch;
    const { session } = await sessionWithRoster(
      ['read_file', 'validate', 'replace_in_file', 'replace_lines', 'write_file'],
      async (name) => {
        // McpBridge prefixes an MCP `isError` body with `ERROR: `.
        if (name === 'replace_lines') return 'ERROR: not found';
        if (name === 'write_file') {
          created = true;
          return 'Wrote tests/migrate.test.ts';
        }
        return 'ERROR: unexpected tool';
      },
    );

    await expect(
      session.sendAndWait(
        "[scenario check] I looked at `tests/migrate.test.ts` and the success criteria aren't met yet. Signals that didn't fire: **test-clean**. Specific failure: migration coverage is missing. Patch the source file.",
      ),
    ).resolves.toBe('');

    expect(created).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(wireNames(bodies[1])).toEqual(['write_file']);
    expect(JSON.stringify(bodies[1]?.messages)).toContain('[Local-model missing-file recovery:');
  });
});

describe('llama-server discarding a whole generation', () => {
  const ROSTER = [
    'read_file',
    'validate',
    'replace_in_file',
    'replace_lines',
    'write_file',
    'message_gezel',
  ];
  const PROMPT =
    "[scenario check] I looked at `src/controller.ts` and the success criteria aren't met yet. Signals that didn't fire: **all-call-sites-updated**. Patch the deliverable with the smallest correct source edit.";

  const failedPatch = (n: number) =>
    toolCallResponse(`call_patch_fail_${n}`, 'replace_in_file', {
      path: 'src/controller.ts',
      find: 'oldValue',
      replace: 'newValue',
    });
  const rewrite = () =>
    toolCallResponse('call_write', 'write_file', {
      path: 'src/controller.ts',
      content: 'export const newValue = 2;\n',
    });

  function repairSession(onWrite: () => void) {
    return sessionWithRoster(ROSTER, async (name) => {
      if (name === 'replace_in_file') return 'ERROR: pattern not found in src/controller.ts';
      if (name === 'read_file') return 'export const oldValue = 1;\n';
      if (name === 'write_file') {
        onWrite();
        return 'Wrote src/controller.ts';
      }
      return 'ERROR: unexpected tool';
    });
  }

  it('resends once with the full tool surface when the engine discards an off-surface call', async () => {
    const bodies: WireBody[] = [];
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as WireBody;
      bodies.push(body);
      if (bodies.length <= 2) return failedPatch(bodies.length);
      if (bodies.length === 3) {
        // The read_file-only refresh surface, answered with a complete
        // write_file the engine's parser cannot accept.
        expect(wireNames(body)).toEqual(['read_file']);
        return sseResponse([PEG_REJECTION]);
      }
      expect(wireNames(body)).toEqual([...ROSTER].sort());
      expect(JSON.stringify(body.messages)).toContain('[Local-model source rewrite refresh:');
      return rewrite();
    }) as typeof fetch;
    const { session, warnings } = await repairSession(() => {
      wroteFile = true;
    });

    await expect(session.sendAndWait(PROMPT)).resolves.toBe('');

    expect(wroteFile).toBe(true);
    expect(bodies).toHaveLength(4);
    // The lost attempt is not committed to the transcript as an empty turn.
    expect(bodies[3]?.messages).toHaveLength(bodies[2]?.messages.length ?? -1);
    expect(warnings.some((w) => w.includes(DISCARD_WARNING))).toBe(false);
  });

  it('widens at most once per send, then reports the discard and falls back to the correctives', async () => {
    const bodies: WireBody[] = [];
    let wroteFile = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as WireBody);
      if (bodies.length <= 2) return failedPatch(bodies.length);
      if (bodies.length === 3 || bodies.length === 4) return sseResponse([PEG_REJECTION]);
      if (bodies.length === 5) {
        return toolCallResponse('call_refresh', 'read_file', {
          path: 'src/controller.ts',
          raw: true,
        });
      }
      return rewrite();
    }) as typeof fetch;
    const { session, warnings } = await repairSession(() => {
      wroteFile = true;
    });

    await expect(session.sendAndWait(PROMPT)).resolves.toBe('');

    expect(wroteFile).toBe(true);
    expect(bodies.map(wireNames)).toEqual([
      ['read_file', 'replace_in_file', 'replace_lines', 'validate'],
      ['read_file', 'replace_in_file', 'replace_lines', 'validate'],
      ['read_file'],
      [...ROSTER].sort(),
      ['read_file'],
      ['write_file'],
    ]);
    expect(warnings.filter((w) => w.includes(DISCARD_WARNING))).toHaveLength(1);
  });

  it('does not resend when the rejected surface already carried every roster tool', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return sseResponse([PEG_REJECTION]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'llama',
      externalTools: [
        { name: 'start_project', description: 'Create a project.', parameters: { type: 'object' } },
      ],
    });
    const warnings: string[] = [];
    session.onWarning?.((msg) => warnings.push(msg));

    await expect(session.sendAndWait('start')).resolves.toBe('');

    expect(requests).toBe(1);
    expect(warnings.some((w) => w.includes(DISCARD_WARNING))).toBe(true);
  });
});

describe('salvaged calls on a single-call repair surface', () => {
  it('executes only the first complete call', async () => {
    const Q = '<|"|>';
    const firstDraft = "test('splits a two-word name', () => {});\n";
    const content = [
      `<|tool_call>call:write_file{content:${Q}${firstDraft}${Q},path:${Q}tests/migrate.test.ts${Q}}<tool_call|>`,
      '<|channel>thought\n<channel|>**Wait**, one more case.\n',
      `<|tool_call>call:write_file{content:${Q}test('second draft', () => {});\n${Q},path:${Q}tests/migrate.test.ts${Q}}<tool_call|>`,
    ].join('');
    globalThis.fetch = (async () =>
      sseResponse([
        { choices: [{ index: 0, delta: { content } }] },
        {
          choices: [{ index: 0, finish_reason: 'length' }],
          usage: { prompt_tokens: 10, completion_tokens: 4096 },
        },
        '[DONE]',
      ])) as typeof fetch;
    const writes: Array<Record<string, unknown>> = [];
    const { session } = await sessionWithRoster(
      ['read_file', 'validate', 'replace_in_file', 'replace_lines', 'write_file'],
      async (name, args) => {
        if (name !== 'write_file') return 'ERROR: unexpected tool';
        writes.push(args);
        return 'Wrote tests/migrate.test.ts';
      },
    );

    await session.sendAndWait(
      "[scenario check] I looked at `tests/migrate.test.ts` and the success criteria aren't met yet. Signals that didn't fire: **tests-present**. Specific failure: tests/migrate.test.ts not present. Use `write_file` to create it.",
    );

    expect(writes).toEqual([{ path: 'tests/migrate.test.ts', content: firstDraft }]);
  });
});
