import type { ToolCallDelta } from './tool-call-protocol.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  images?: string[];
}

export interface ChatCompletionChunk {
  choices?: Array<{
    index: number;
    delta: { role?: string; content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  /**
   * mlx_vlm.server emits Responses-API field names (`input_tokens` /
   * `output_tokens`) while older OpenAI-compatible servers (including
   * llama.cpp's, ollama's, and the Chat Completions reference shape)
   * use `prompt_tokens` / `completion_tokens`. We accept both so this
   * type can flex across engines if we ever point the provider at
   * a different OpenAI-compatible host. mlx_vlm also ships
   * `prompt_tps` (prefill speed, set on first chunk) and
   * `generation_tps` (running decode speed, updated per chunk).
   */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tps?: number;
    generation_tps?: number;
    /** Prompt tokens actually served from the MLX KV cache. */
    cached_tokens?: number;
  };
}

export function setChatTemplateKwarg(
  body: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const existing = body.chat_template_kwargs;
  if (existing && typeof existing === 'object' && existing !== null) {
    (existing as Record<string, unknown>)[key] = value;
    return;
  }
  body.chat_template_kwargs = { [key]: value };
}
