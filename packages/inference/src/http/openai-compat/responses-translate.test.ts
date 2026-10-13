import { describe, expect, it } from 'vitest';
import {
  ResponsesRequestSchema,
  flattenResponsesNamespaceToolName,
  translateResponsesRequest,
  unwrapCustomToolInput,
  wrapCustomToolInput,
} from './responses-translate.js';

describe('ResponsesRequestSchema and current Codex request', () => {
  it('accepts and translates the Codex 0.147 request envelope', () => {
    const request = ResponsesRequestSchema.parse({
      model: 'llama-cpp:qwen3-coder',
      instructions: 'You are Codex. Work carefully.',
      input: [
        {
          type: 'message',
          id: 'msg_user_1',
          role: 'user',
          content: [{ type: 'input_text', text: 'Inspect the repository.' }],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          description: 'Run a command.',
          strict: false,
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd'],
          },
        },
        {
          type: 'namespace',
          name: 'multi_agent_v1',
          description: 'Manage helper agents.',
          tools: [
            {
              type: 'function',
              name: 'spawn_agent',
              description: 'Start a helper.',
              strict: false,
              parameters: {
                type: 'object',
                properties: { task: { type: 'string' } },
                required: ['task'],
              },
            },
          ],
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { summary: 'auto' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'codex-cache-key',
      client_metadata: { originator: 'codex_cli_rs' },
    });

    const translated = translateResponsesRequest(request);

    expect(translated.sessionInput).toEqual({
      systemMessage: 'You are Codex. Work carefully.',
      prompt: 'Inspect the repository.',
      priorMessages: [],
      attachments: [],
    });
    expect(translated.externalTools).toEqual([
      {
        name: 'exec_command',
        description: 'Run a command.',
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
        },
      },
      {
        name: 'multi_agent_v1__spawn_agent',
        description: 'Manage helper agents.\n\nStart a helper.',
        parameters: {
          type: 'object',
          properties: { task: { type: 'string' } },
          required: ['task'],
        },
      },
    ]);
    expect(translated.toolBindings).toEqual({
      exec_command: { kind: 'function', name: 'exec_command' },
      multi_agent_v1__spawn_agent: {
        kind: 'function',
        name: 'spawn_agent',
        namespace: 'multi_agent_v1',
      },
    });
    expect(translated.toolKinds).toEqual({
      exec_command: 'function',
      multi_agent_v1__spawn_agent: 'function',
    });
    expect(translated.toolChoice).toEqual({ mode: 'auto' });
    expect(translated.parallelToolCalls).toBe(false);
    expect(translated.reasoning).toEqual({ summary: 'auto' });
    expect(translated.store).toBe(false);
    expect(translated.stream).toBe(true);
  });

  it('accepts the multi-kilobyte namespace guidance emitted by Codex plugins', () => {
    const namespaceDescription = 'Collaboration guidance. '.repeat(160);
    const request = ResponsesRequestSchema.parse({
      model: 'llama-cpp:qwen3-coder',
      input: 'Delegate this review.',
      tools: [
        {
          type: 'namespace',
          name: 'multi_agent_v1',
          description: namespaceDescription,
          tools: [
            {
              type: 'function',
              name: 'spawn_agent',
              description: 'Start a helper.',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
      ],
    });

    const translated = translateResponsesRequest(request);
    expect(translated.externalTools[0]?.description).toBe(
      `${namespaceDescription}\n\nStart a helper.`,
    );
  });
});

describe('translateResponsesRequest history', () => {
  it('preserves the full stateless message and function-call transcript', () => {
    const request = ResponsesRequestSchema.parse({
      model: 'llama-cpp:qwen3-coder',
      instructions: 'Use tools when useful.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Inspect status.' }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'exec_command',
          arguments: '{"cmd":"git status --short"}',
        },
        {
          type: 'function_call',
          id: 'fc_2',
          call_id: 'call_2',
          namespace: 'multi_agent_v1',
          name: 'spawn_agent',
          arguments: '{"task":"Review tests"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'clean',
        },
        {
          type: 'function_call_output',
          call_id: 'call_2',
          output: [{ type: 'input_text', text: 'agent started' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The tree is clean.' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'What next?' }],
        },
      ],
      tools: [],
    });

    const { sessionInput } = translateResponsesRequest(request);

    expect(sessionInput.systemMessage).toBe('Use tools when useful.');
    expect(sessionInput.prompt).toBe('What next?');
    expect(sessionInput.priorMessages).toEqual([
      { role: 'user', content: 'Inspect status.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'exec_command',
            arguments: '{"cmd":"git status --short"}',
          },
          {
            id: 'call_2',
            name: 'multi_agent_v1__spawn_agent',
            arguments: '{"task":"Review tests"}',
          },
        ],
      },
      { role: 'tool', content: 'clean', toolCallId: 'call_1' },
      { role: 'tool', content: 'agent started', toolCallId: 'call_2' },
      { role: 'assistant', content: 'The tree is clean.' },
    ]);
  });

  it('keeps a final tool result as history and uses an empty continuation prompt', () => {
    const request = ResponsesRequestSchema.parse({
      model: 'llama-cpp:qwen3-coder',
      input: [
        { type: 'message', role: 'user', content: 'Read the file.' },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'hello' },
      ],
    });

    const { sessionInput } = translateResponsesRequest(request);
    expect(sessionInput.prompt).toBe('');
    expect(sessionInput.priorMessages.at(-1)).toEqual({
      role: 'tool',
      content: 'hello',
      toolCallId: 'call_1',
    });
  });
});

describe('custom/free-form tool wrapping', () => {
  it('wraps a custom tool as a deterministic JSON function and round-trips its input', () => {
    const request = ResponsesRequestSchema.parse({
      model: 'llama-cpp:qwen3-coder',
      input: [
        { type: 'message', role: 'user', content: 'Apply the patch.' },
        {
          type: 'custom_tool_call',
          call_id: 'call_patch',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_patch',
          name: 'apply_patch',
          output: 'Done!',
        },
        { type: 'message', role: 'user', content: 'Summarize it.' },
      ],
      tools: [
        {
          type: 'custom',
          name: 'apply_patch',
          description: 'Apply a patch.',
          format: { type: 'grammar', syntax: 'lark', definition: 'start: PATCH' },
        },
      ],
      max_output_tokens: 2_048,
      reasoning: { effort: 'high', summary: 'auto' },
    });

    const translated = translateResponsesRequest(request);
    expect(translated.externalTools).toEqual([
      {
        name: 'apply_patch',
        description: 'Apply a patch.',
        parameters: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description:
                'The free-form input to pass to this custom tool. Input must conform to this lark grammar:\nstart: PATCH',
            },
          },
          required: ['input'],
          additionalProperties: false,
        },
      },
    ]);
    expect(translated.toolBindings.apply_patch).toEqual({
      kind: 'custom',
      name: 'apply_patch',
      customFormat: { type: 'grammar', syntax: 'lark', definition: 'start: PATCH' },
    });
    expect(translated.sessionInput.priorMessages).toEqual([
      { role: 'user', content: 'Apply the patch.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_patch',
            name: 'apply_patch',
            arguments: '{"input":"*** Begin Patch\\n*** End Patch"}',
          },
        ],
      },
      { role: 'tool', content: 'Done!', toolCallId: 'call_patch' },
    ]);
    expect(translated.maxOutputTokens).toBe(2_048);
    expect(translated.reasoning).toEqual({ effort: 'high', summary: 'auto' });

    const encoded = wrapCustomToolInput('raw\ninput');
    expect(encoded).toBe('{"input":"raw\\ninput"}');
    expect(unwrapCustomToolInput(encoded)).toBe('raw\ninput');
  });
});

describe('namespace and tool-choice mapping', () => {
  it('maps a pinned namespaced choice onto its local name and wire binding', () => {
    const request = ResponsesRequestSchema.parse({
      model: 'llama-cpp:qwen3-coder',
      input: 'Delegate this.',
      tools: [
        {
          type: 'namespace',
          name: 'multi_agent_v1',
          tools: [
            {
              type: 'function',
              name: 'spawn_agent',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
      ],
      tool_choice: {
        type: 'function',
        namespace: 'multi_agent_v1',
        name: 'spawn_agent',
      },
    });

    const translated = translateResponsesRequest(request);
    expect(translated.toolChoice).toEqual({
      mode: 'required',
      name: 'multi_agent_v1__spawn_agent',
      kind: 'function',
    });
  });

  it('bounds long flattened namespace names with a stable hash suffix', () => {
    const first = flattenResponsesNamespaceToolName(
      'namespace_with_a_name_that_is_deliberately_long',
      'tool_with_an_equally_deliberately_long_name',
    );
    const second = flattenResponsesNamespaceToolName(
      'namespace_with_a_name_that_is_deliberately_long',
      'tool_with_an_equally_deliberately_long_name',
    );
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).toMatch(/__[a-f0-9]{12}$/);
  });
});
