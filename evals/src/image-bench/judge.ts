/**
 * A vision chat model reads each render: does it show what was asked, what
 * text does it carry, and what is visibly wrong. Spelling is then checked in
 * code against the words the prompt requires, so the judge only has to
 * transcribe, which small vision models do far more reliably than grade.
 *
 * Talks to any OpenAI-compatible chat endpoint that accepts image parts: a
 * bare llama-server started with a vision projector, a daemon's `/v1`, or a
 * cloud model.
 */
import type { ImageBenchPrompt } from './prompts.ts';

export interface JudgeVerdict {
  /** The judge says the image shows what the prompt asked for. */
  matches: boolean;
  /** Visible text as the judge transcribed it. */
  text: string;
  /** Every required word appears in the transcription; absent when the prompt requires none. */
  textCorrect?: boolean;
  defects: string[];
  /** 1-5: 5 means a person would use it as is. */
  score: number;
}

export interface JudgeEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /**
   * Fields merged into every request, for a model that needs its own
   * settings: muse-glimmer answers with `chat_template_kwargs:
   * {reasoning_strength: "low"}` and returns HTTP 500 when its reasoning is
   * cut off with a budget of zero.
   */
  extraBody?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

export function judgeInstructions(prompt: ImageBenchPrompt): string {
  return [
    'You are checking an AI-generated image against the request it was made from.',
    `Request: "${prompt.prompt}"`,
    `It should show: ${prompt.expect}`,
    'Reply with JSON only, no prose:',
    '{"matches": true or false (does the image show what was asked),',
    ' "text": "every word of visible text, exactly as spelled, empty if none",',
    ' "defects": ["short phrases for visible flaws, such as extra fingers, distorted face, garbled text, wrong count, duplicated subject, cut-off subject"],',
    ' "score": 1 to 5 (5 = a person would use it as is, 1 = unusable)}',
  ].join('\n');
}

const normalize = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9°]+/g, ' ')
    .trim();

/** Every required word appears in the transcription, ignoring case and punctuation. */
export function requiredTextPresent(required: readonly string[], transcription: string): boolean {
  const seen = ` ${normalize(transcription)} `;
  return required.every((word) => seen.includes(` ${normalize(word)} `));
}

/** Pull the first JSON object out of a reply that may wrap it in prose or a code fence. */
export function parseJudgeReply(reply: string, prompt: ImageBenchPrompt): JudgeVerdict {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new Error(`judge reply carried no JSON: ${reply.slice(0, 200)}`);
  const raw = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const score = Number(raw.score);
  return {
    matches: raw.matches === true,
    text,
    ...(prompt.text ? { textCorrect: requiredTextPresent(prompt.text, text) } : {}),
    defects: Array.isArray(raw.defects)
      ? raw.defects.filter((d): d is string => typeof d === 'string')
      : [],
    score: Number.isFinite(score) ? Math.min(5, Math.max(1, Math.round(score))) : 1,
  };
}

export async function judgeImage(
  endpoint: JudgeEndpoint,
  png: Buffer,
  prompt: ImageBenchPrompt,
): Promise<JudgeVerdict> {
  const res = await (endpoint.fetchImpl ?? fetch)(
    `${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      // A judged image takes seconds; a server that has not answered in two
      // minutes is wedged, and the caller retries.
      signal: AbortSignal.timeout(120_000),
      headers: {
        'content-type': 'application/json',
        ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0,
        // Room for a short reasoning pass before the JSON on thinking models.
        max_tokens: 1500,
        ...endpoint.extraBody,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
              },
              { type: 'text', text: judgeInstructions(prompt) },
            ],
          },
        ],
      }),
    },
  );
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return parseJudgeReply(body.choices?.[0]?.message?.content ?? '', prompt);
}
