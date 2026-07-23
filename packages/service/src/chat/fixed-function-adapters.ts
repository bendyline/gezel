/**
 * Adapters that translate a raw MCP tool-call text result into the
 * brief, user-facing assistant message body shown by a fixed-function
 * gezel.
 *
 * The raw text returned by a tool like `generate_image` is written
 * for an LLM consumer — it ends with paragraphs of instructions
 * ("DO NOT embed it again as Markdown…", "to iterate, pass
 * inputImages: …", etc.). For an LLM-backed gezel that tail is
 * load-bearing context for the next turn. For a fixed-function
 * gezel there is no next turn — the user just sees the bubble. The
 * instruction tail becomes noise that pushes the actually-useful
 * fact (dimensions, model, seed) below the fold.
 *
 * Adapters are matched by MCP tool name. When no adapter is
 * registered, {@link firstSentence} runs as the fallback so any
 * future fixed-function gezel still gets a sensibly-trimmed bubble
 * without us hand-writing a rule first.
 */

import { stripGezelMentions as stripGezelMentionMarkup } from '@bendyline/gezel';

export interface FixedFunctionAdapter {
  /**
   * Compose the user-facing assistant message body from the raw
   * tool result text + the args the tool was called with. Return an
   * empty string to suppress the body entirely — the tool-call row
   * with its thumbnail and arg preview is already shown above the
   * bubble, so an empty body just removes the bubble area without
   * losing information.
   */
  formatResult(rawText: string, toolArgs: Record<string, unknown>): string;
}

/**
 * Strip `@[Label](gezel:id)` (and the backslash-escaped variant
 * `gezel\:id`, optionally `?project=<id>`) mentions from the user
 * text so they don't get forwarded into a fixed-function tool's
 * prompt argument. The mention is the UI's way of routing the
 * message to this gezel — once routing is done, the markup is
 * meaningless to the tool. A `generate_image` call where the
 * prompt starts with `@[Glen](gezel:glen?project=…) car full of
 * tomatoes` produces a worse image than just `car full of
 * tomatoes`.
 *
 * Drops only the mention syntax. Surrounding whitespace is
 * collapsed to single spaces and trimmed; arbitrary other
 * characters in the input are preserved.
 *
 * Uses the shared core mention parser so UI routing and service-side
 * passthrough prompts stay on the same markdown contract.
 */
export function stripGezelMentions(text: string): string {
  return stripGezelMentionMarkup(text);
}

/**
 * Conversational lead-ins that a person naturally types at a passthrough
 * generative gezel ("can you generate a smiling cat?") but that are NOT
 * part of the visual description. Diffusion models render the literal
 * text concept, so "Can you generate a smiling cat?" produces a worse
 * image than "a smiling cat" — the framing words become subject matter.
 * Peeled iteratively from the front; order doesn't matter because we
 * loop until nothing more matches. Medium phrases ("a video of") strip
 * their leading article along with them, but a bare "a"/"the" is left
 * alone (it's part of the description).
 */
const GENERATIVE_PROMPT_LEAD_INS = [
  // politeness / request framing
  'can you',
  'could you',
  'would you',
  'will you',
  'can we',
  'could we',
  'please',
  'pls',
  'kindly',
  "i'd like",
  'i would like',
  'i want',
  'i need',
  "let's",
  'lets',
  // generative verbs
  'generate',
  'create',
  'make',
  'draw',
  'render',
  'produce',
  'design',
  'paint',
  'animate',
  'show me',
  'give me',
  'get me',
  'make me',
  'draw me',
  // medium framing (article peeled with the phrase)
  'a video of',
  'an animation of',
  'a clip of',
  'a movie of',
  'a picture of',
  'an image of',
  'a photo of',
  'a drawing of',
  'a rendering of',
  'a render of',
  'video of',
  'image of',
  'picture of',
  // Chattier framings — video gezels get more conversational asks than
  // image ones ("how about a video of…", "i'd love a clip of…").
  "i'd love",
  'i would love',
  'i want to see',
  "i'd love to see",
  'how about',
  'what about',
  'put together',
  'come up with',
  'a short video of',
  'a short clip of',
  'a quick video of',
  'a gif of',
  'footage of',
  'a video where',
  'a video showing',
  'a video with',
  'a clip showing',
]
  // Longest first so a multi-word phrase ("make me", "a video of") wins
  // over its shorter prefix ("make", "video of") in the match loop.
  .sort((a, b) => b.length - a.length);

/**
 * Strip conversational framing from a prompt headed to a generative tool
 * (`generate_image` / `generate_video`). "Can you generate a smiling
 * cat?" → "a smiling cat". Falls back to the original when stripping
 * would leave nothing (e.g. the user literally typed "generate a video"),
 * so the engine never gets an empty prompt.
 */
export function cleanGenerativePrompt(text: string): string {
  const original = text.trim();
  let s = original;
  let changed = true;
  while (changed) {
    changed = false;
    const lower = s.toLowerCase();
    for (const lead of GENERATIVE_PROMPT_LEAD_INS) {
      if (lower === lead || lower.startsWith(`${lead} `)) {
        // Drop the lead-in plus any following separators/whitespace.
        s = s.slice(lead.length).replace(/^[\s,:;-]+/, '');
        changed = true;
        break;
      }
    }
  }
  // Trailing request punctuation + a sign-off "please"/"pls" (almost never
  // the subject at the very end). Looped so "smiling cat, please." peels
  // fully. Internal commas/periods are kept — they're part of a description.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/[?.!\s]+$/, '').trim();
    s = s.replace(/[\s,]+(?:please|pls)$/i, '').trim();
  } while (s !== prev);
  return s.length > 0 ? s : original;
}

/**
 * Word count at/above which a (framing-stripped) video prompt is treated
 * as a deliberate, detailed shot and passed through untouched — no model
 * call. Below it the prompt is terse ("smiling cat"), which LTX / LTX-2
 * render as warbly, low-detail mush, so those are expanded.
 */
export const VIDEO_PROMPT_EXPANSION_WORD_CEILING = 16;

/**
 * The self-contained instruction the gezel's own model answers to turn a
 * terse idea into a detailed LTX/LTX-2 shot. The one-shot path supplies
 * only a generic "follow the requested output format" system message, so
 * all the steering lives in this single prompt. LTX models are trained on
 * long, descriptive captions; the structure here (subject → motion →
 * setting → light → camera) mirrors what the Lightricks prompt guide asks
 * for.
 */
export function buildVideoPromptExpansionInput(idea: string): string {
  return `You write prompts for a text-to-video model (LTX). Expand the short idea below into ONE vivid, present-tense shot description written as flowing prose — not a list. In one natural flow, cover: the main subject and its appearance; the single action or motion it performs; the setting and background; the lighting, time of day, and mood; and the camera framing and movement. Keep it concrete and filmable — 2 to 4 sentences, about 40 to 70 words. Stay faithful to the idea; do not invent a different subject. Output ONLY the description: no title, quotes, preamble, options, lists, or commentary.\n\nIdea: ${idea}`;
}

/**
 * Pull a clean single-paragraph prompt out of a local model's raw reply.
 * Verbose families leak `<think>` blocks and chatty preambles ("Sure!
 * Here's a description:"); diffusion models want just the description.
 * Returns `''` when nothing usable remains (caller falls back to the
 * un-expanded prompt).
 */
export function sanitizeExpandedVideoPrompt(raw: string): string {
  if (!raw) return '';
  let s = raw;
  // Drop leaked reasoning. Remove closed <think> blocks; if an unclosed
  // tag remains, keep only what follows the last reasoning marker.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  if (/<\/?think/i.test(s)) s = s.split(/<\/?think(?:ing)?>/i).pop() ?? s;
  // Strip code-fence MARKERS (keep the content inside) + stray backticks,
  // then collapse all whitespace to single spaces.
  s = s
    .replace(/```[a-z]*/gi, ' ')
    .replace(/`+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Peel leading labels ("Prompt:", "Description —") and chatty preambles
  // ("Sure!", "Here is the shot:"), looped since models stack them.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^(?:prompt|description|shot|output|video)\s*[:\-–—]\s*/i, '');
    s = s.replace(/^(?:sure|certainly|here(?:'s| is)|of course|okay|ok)\b[^.!?:]*[:.!?]\s*/i, '');
  } while (s !== prev);
  // Strip surrounding quotes / stray markdown emphasis (straight + smart).
  s = s
    .replace(/^["'“”*]+/, '')
    .replace(/["'“”*]+$/, '')
    .trim();
  // Length guard: cap near 700 chars on a sentence boundary.
  if (s.length > 700) {
    const cut = s.slice(0, 700);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = (stop > 200 ? cut.slice(0, stop + 1) : cut).trim();
  }
  return s;
}

/**
 * Expand a short, framing-stripped video prompt into a detailed LTX/LTX-2
 * shot via the gezel's own model. A prompt at/above
 * {@link VIDEO_PROMPT_EXPANSION_WORD_CEILING} words is assumed deliberate
 * and passes through with NO model call. Any failure — error, timeout, or
 * unusable output — falls back to the input, so expansion can only help,
 * never block a generation.
 *
 * `complete(input, timeoutMs)` runs one self-contained completion; the
 * manager wires it to `oneShotCompletion` with the gezel's own model.
 */
export async function expandVideoPrompt(
  prompt: string,
  complete: (input: string, timeoutMs: number) => Promise<string>,
  opts: { timeoutMs?: number; wordCeiling?: number } = {},
): Promise<string> {
  const cleaned = prompt.trim();
  if (!cleaned) return prompt;
  const ceiling = opts.wordCeiling ?? VIDEO_PROMPT_EXPANSION_WORD_CEILING;
  if (countWords(cleaned) >= ceiling) return cleaned; // already detailed
  let raw: string;
  try {
    raw = await complete(buildVideoPromptExpansionInput(cleaned), opts.timeoutMs ?? 30_000);
  } catch {
    return cleaned;
  }
  const expanded = sanitizeExpandedVideoPrompt(raw);
  // Accept only a genuinely richer result: a real phrase, and longer than
  // the bare idea. Otherwise the model under-delivered — keep the idea.
  if (countWords(expanded) < 5 || expanded.length <= cleaned.length) return cleaned;
  return expanded;
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Keep the first sentence (or the first line, whichever ends sooner).
 * Used as the default when no per-tool adapter is registered.
 */
export function firstSentence(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  const dot = trimmed.indexOf('. ');
  const nl = trimmed.indexOf('\n');
  let cut = trimmed.length;
  if (dot >= 0 && dot + 1 < cut) cut = dot + 1;
  if (nl >= 0 && nl < cut) cut = nl;
  return trimmed.slice(0, cut).trim();
}

const ADAPTERS: Record<string, FixedFunctionAdapter> = {
  generate_image: {
    /**
     * `generate_image` returns a long line that starts with the
     * useful summary (`Generated WxH image with <model> ...`) and then
     * trails into LLM-only instructions. Preserve the workspace `<img>`
     * snippet when present: fixed-function image gezels often hand the
     * result back to a builder, and that exact path is load-bearing for
     * HTML tasks.
     */
    formatResult(rawText) {
      const match = /Generated\s+(\d+\s*[×x]\s*\d+)\s+image\s+with\s+(\S+)/i.exec(rawText);
      if (match) {
        const dims = match[1]!.replace(/\s+/g, '');
        const model = match[2]!;
        const imgTag = /<img\s+src="([^"]+)">/i.exec(rawText);
        if (imgTag) {
          return `Generated ${dims} image with ${model}. Use \`<img src="${imgTag[1]!}">\` in workspace HTML.`;
        }
        return `Generated ${dims} image with ${model}.`;
      }
      return firstSentence(rawText);
    },
  },
  generate_video: {
    /**
     * `generate_video` returns a summary line (`Generated WxH video with
     * <model> (N frames @ Mfps ...)`) that trails into LLM-only notes.
     * Preserve the workspace `<video>` snippet when present so a
     * fixed-function video gezel feeding a builder keeps the embeddable
     * path. Mirrors the `generate_image` adapter.
     */
    formatResult(rawText) {
      const match = /Generated\s+(?:a\s+)?(\d+\s*[×x]\s*\d+)\s+video\s+with\s+(\S+)/i.exec(rawText);
      if (match) {
        const dims = match[1]!.replace(/\s+/g, '');
        const model = match[2]!.replace(/[.,]$/, '');
        const videoTag = /<video\s+src="([^"]+)"[^>]*>/i.exec(rawText);
        if (videoTag) {
          return `Generated ${dims} video with ${model}. Use \`<video src="${videoTag[1]!}" controls></video>\` in workspace HTML.`;
        }
        return `Generated ${dims} video with ${model}.`;
      }
      return firstSentence(rawText);
    },
  },
};

/**
 * Format the assistant message body for a fixed-function tool call.
 * Falls back to {@link firstSentence} when no adapter is registered
 * for the tool.
 */
export function formatFixedFunctionResult(
  toolName: string,
  rawText: string,
  toolArgs: Record<string, unknown>,
): string {
  const adapter = ADAPTERS[toolName];
  if (adapter) return adapter.formatResult(rawText, toolArgs);
  return firstSentence(rawText);
}
