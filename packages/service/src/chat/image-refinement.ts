/**
 * Follow-up handling for fixed-function image gezels.
 *
 * A fixed-function `generate_image` session has no LLM in the loop, so a
 * message like "no lettering at the bottom" historically became the ENTIRE
 * diffusion prompt — three unrelated images for three refinement attempts
 * (the wild-caught woodcut-craftsman session). This module gives the
 * passthrough path a memory of the previous generation:
 *
 *   1. {@link classifyImageFollowUp} decides deterministically whether a
 *      message starts a new image or continues the previous one, and which
 *      continuation shape fits (see {@link ImageFollowUpKind}).
 *   2. {@link composeImageRefinementPrompt} rewrites a refinement into a
 *      full standalone prompt via a one-shot LLM call (same pattern as
 *      `expandVideoPrompt`), falling back to a deterministic composition
 *      when the model is unavailable or under-delivers. Composition can
 *      only help — every failure path returns something usable.
 *
 * The caller (ChatManager.runFixedFunctionSend) threads the results into
 * the `generate_image` args: same seed for composition-stable revisions,
 * `inputImages` for img2img edits when the model supports it.
 */

export interface PreviousImageGeneration {
  /** Full prompt sent to the engine on the previous generation. */
  prompt: string;
  negativePrompt?: string | undefined;
  /** Artifact path of the previous PNG (project-relative). */
  artifactPath: string;
  seed?: number | undefined;
}

/**
 * How a message relates to the session's previous generation:
 *   - `fresh` — a new, self-contained image request; no threading.
 *   - `variation` — "another one", "try again": same prompt, new seed.
 *   - `revise` — the change removes/forbids something ("no lettering at
 *     the bottom"): regenerate txt2img with the composed prompt and the
 *     SAME seed — img2img would fight a removal because the unwanted
 *     element is baked into the init latents, while a seed-stable
 *     regenerate keeps the composition and drops the element.
 *   - `edit` — an additive or attribute change ("add a hat", "darker"):
 *     img2img from the previous image (plus the composed prompt), which
 *     preserves what's already there. The previous seed rides along so
 *     the composition survives even when img2img gets dropped by a model
 *     that doesn't support it.
 */
export type ImageFollowUpKind = 'fresh' | 'variation' | 'revise' | 'edit';

/**
 * Denoising strength for img2img edits: low enough to keep the source
 * image's composition recognizable, high enough that the requested
 * change actually lands.
 */
export const IMG2IMG_EDIT_STRENGTH = 0.6;

const VARIATION_RE =
  /^(?:another(?: one)?|one more|again|try again|redo|regenerate|re-generate|do (?:it|that) again|give me (?:another|one more)|more like (?:this|that)|more options|variations?)[.!?\s]*$/i;

/**
 * Openers that introduce a NEW subject even when a previous image exists
 * ("draw a picture of…", "an image of…", "now generate a logo for…").
 * Checked before the follow-up signals so a fresh request containing an
 * incidental "the background" doesn't get misread as a refinement.
 */
const NEW_SUBJECT_RE =
  /^(?:(?:please|pls|kindly)\s+)?(?:(?:can|could|would|will)\s+(?:you|we)\s+)?(?:now\s+)?(?:generate|create|draw|render|paint|design|produce|make|show|give)\b[^.?!]*\b(?:image|picture|photo|logo|drawing|illustration|icon|poster|banner|scene|portrait|of)\b/i;

const NEW_SUBJECT_MEDIUM_RE =
  /^(?:an?\s+)?(?:image|picture|photo|drawing|illustration|logo|icon|poster|banner|portrait|scene)\s+of\b/i;

/**
 * Leading connectives that read as "…continuing the previous image".
 * Matched at the start of the message only — mid-sentence hits are too
 * noisy ("a knight with a sword" must stay fresh).
 */
const CONNECTIVE_OPENER_RE =
  /^(?:but|and|also|plus|now|ok(?:ay)?[,\s]|no[,\s]|no\b|nope|not|without|with(?:out)?|except|instead|same|this time|actually|still|keep|make (?:it|the|him|her|them)|can it|could it|what if|add|remove|drop|delete|erase|get rid|change|turn|give (?:it|him|her|them)|put|move|zoom|crop|rotate|flip|closer|further|tighter|wider|bigger|smaller|larger|darker|lighter|brighter|less|more|try (?:it )?(?:with|in|without)|in (?:colou?r|black and white)|as a|minus)\b/i;

/**
 * Anaphora — the message refers back to something already on screen.
 * Includes definite-article nouns about the image-as-artifact ("the
 * background", "the text", "the bottom") that only make sense against an
 * existing image. Deliberately excludes scene-content nouns (sky, face,
 * hair, …) — fresh prompts routinely contain "with mountains in the
 * sky". Applied only to SHORT messages (see classifyImageFollowUp): a
 * long descriptive prompt carries its own antecedents ("a wizard on a
 * cliff with mountains in the background"), so pronouns and definite
 * articles inside it are not references to the previous image.
 */
const ANAPHORA_RE =
  /\b(?:it|that one|this one|the same(?: one)?|him|her|them)\b|\bthe (?:image|picture|photo|drawing|render|logo|background|foreground|text|lettering|caption|title|words?|font|colou?rs?|palette|style|composition|top|bottom|left|right|corner|edges?|border|frame)\b/i;

/** Word ceiling under which anaphora signals count as follow-up evidence. */
const ANAPHORA_WORD_CEILING = 8;

/**
 * Bare comparative fragments ("darker", "a bit warmer", "more detailed",
 * "zoom out") — meaningless as standalone prompts, unmistakable as
 * refinements when an image precedes them.
 */
const BARE_TWEAK_RE =
  /^(?:much |a (?:bit|little|touch) |slightly |way |even |far )?(?:more|less|darker|lighter|brighter|warmer|cooler|bigger|smaller|larger|wider|narrower|tighter|closer|sharper|softer|simpler|cleaner|busier|bolder|flatter|richer|zoom(?:ed)?(?: (?:in|out))?)\b/i;

/**
 * Removal phrasing anywhere in the message — steers `revise` (seed-stable
 * txt2img) over `edit` (img2img), because init latents preserve exactly
 * the thing the user wants gone.
 */
const REMOVAL_RE =
  /(?:^|[\s,])(?:no|without|remove|get rid of|rid of|drop|delete|erase|lose|hide|minus)\b/i;

export function classifyImageFollowUp(message: string, hasPrevious: boolean): ImageFollowUpKind {
  const text = message.trim();
  if (!hasPrevious || text.length === 0) return 'fresh';
  if (VARIATION_RE.test(text)) return 'variation';
  if (NEW_SUBJECT_RE.test(text) || NEW_SUBJECT_MEDIUM_RE.test(text)) return 'fresh';
  const isFollowUp =
    CONNECTIVE_OPENER_RE.test(text) ||
    BARE_TWEAK_RE.test(text) ||
    (countWords(text) <= ANAPHORA_WORD_CEILING && ANAPHORA_RE.test(text));
  if (!isFollowUp) return 'fresh';
  return REMOVAL_RE.test(text) ? 'revise' : 'edit';
}

/**
 * The self-contained instruction the gezel's own model answers to fold a
 * refinement into the previous prompt. Mirrors the video-expansion
 * pattern: the one-shot path has no persona steering, so everything the
 * model needs lives in this single input.
 */
export function buildImageRefinementInput(previousPrompt: string, refinement: string): string {
  return `You maintain the prompt for a text-to-image model. The previous image was generated from this prompt:\n\n${previousPrompt}\n\nThe user now asks for this change:\n\n${refinement}\n\nWrite the FULL revised prompt: one complete, standalone visual description that keeps everything from the previous prompt the user did not change and applies the requested change. If the change removes or forbids something, leave it out of the prompt and put it on the AVOID line instead. Reply with exactly two lines and nothing else:\nPROMPT: <the full revised prompt>\nAVOID: <comma-separated concepts the image must not contain, or none>`;
}

/**
 * Pull `{ prompt, avoid }` out of a local model's raw reply. Tolerates
 * leaked `<think>` blocks, code fences, label variants (`**Prompt** —`),
 * and a bare single-paragraph answer with no labels at all. Returns null
 * when nothing usable remains — the caller falls back to deterministic
 * composition.
 */
export function parseImageRefinementReply(raw: string): { prompt: string; avoid?: string } | null {
  if (!raw) return null;
  let s = raw;
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  if (/<\/?think/i.test(s)) s = s.split(/<\/?think(?:ing)?>/i).pop() ?? s;
  s = s.replace(/```[a-z]*/gi, ' ').replace(/`+/g, ' ');

  const promptMatch = /^\s*(?:\*\*)?prompt(?:\*\*)?\s*[:\-–—]\s*(.+)$/im.exec(s);
  const avoidMatch = /^\s*(?:\*\*)?avoid(?:\*\*)?\s*[:\-–—]\s*(.+)$/im.exec(s);

  let prompt = promptMatch?.[1]?.trim() ?? '';
  if (!prompt) {
    // No label — accept a bare single-paragraph reply as the prompt.
    const collapsed = s.replace(/\s+/g, ' ').trim();
    if (!collapsed || /^avoid\b/i.test(collapsed)) return null;
    prompt = collapsed;
  }
  prompt = stripWrappingQuotes(prompt);
  if (countWords(prompt) < 3) return null;
  if (prompt.length > 1200) {
    const cut = prompt.slice(0, 1200);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '));
    prompt = (stop > 300 ? cut.slice(0, stop + 1) : cut).trim();
  }

  let avoid = stripWrappingQuotes(avoidMatch?.[1]?.trim() ?? '');
  if (/^(?:none|nothing|n\/a|-|—)[.!\s]*$/i.test(avoid)) avoid = '';
  return { prompt, ...(avoid ? { avoid } : {}) };
}

/**
 * Deterministic fallback composition — used when no chat model is
 * reachable or the one-shot under-delivers. Removal phrasing keeps the
 * previous prompt intact and routes the removed concepts into the
 * negative prompt; anything else appends the refinement to the previous
 * prompt.
 */
export function heuristicRefinementComposition(
  prev: PreviousImageGeneration,
  refinement: string,
): { prompt: string; negativePrompt?: string } {
  const cleaned = refinement
    .trim()
    .replace(/^(?:but|and|also|plus|now|ok(?:ay)?|actually|this time|same but)[\s,]+/i, '')
    .replace(/[?.!\s]+$/, '')
    .trim();

  const removals: string[] = [];
  const pushRemoval = (phrase: string | undefined) => {
    if (!phrase) return;
    // "the lettering and the border" is two concepts for the negative
    // prompt, not one — split on conjunctions and shed the articles.
    for (const piece of phrase.split(/\s+(?:and|or|&)\s+/i)) {
      const trimmed = piece.replace(/^(?:the|a|an|any|all)\s+/i, '').trim();
      if (trimmed) removals.push(trimmed);
    }
  };
  const leadingRemoval = /^(?:with\s+)?(?:no|without)\s+(.+)$/i.exec(cleaned);
  pushRemoval(leadingRemoval?.[1]?.trim());
  const verbRemovals = cleaned.matchAll(
    /\b(?:remove|get rid of|rid of|drop|delete|erase|hide|lose)\s+(?:the\s+|any\s+|all\s+)?([^,.;!?]+)/gi,
  );
  for (const m of verbRemovals) {
    pushRemoval(m[1]?.trim());
  }

  if (removals.length > 0) {
    return {
      prompt: prev.prompt,
      negativePrompt: mergeNegativePrompts(prev.negativePrompt, removals.join(', ')),
    };
  }
  const appended = cleaned.length > 0 ? `${prev.prompt}, ${cleaned}` : prev.prompt;
  return {
    prompt: appended,
    ...(prev.negativePrompt ? { negativePrompt: prev.negativePrompt } : {}),
  };
}

/**
 * Compose the full revised prompt for a refinement via the gezel's own
 * model, falling back to {@link heuristicRefinementComposition} on any
 * failure — error, timeout, or unusable output. Mirrors the
 * `expandVideoPrompt` contract: composition can only help, never block a
 * generation.
 *
 * `complete(input, timeoutMs)` runs one self-contained completion; the
 * manager wires it to `oneShotCompletion` with the gezel's own model.
 */
export async function composeImageRefinementPrompt(
  prev: PreviousImageGeneration,
  refinement: string,
  complete: (input: string, timeoutMs: number) => Promise<string>,
  opts: { timeoutMs?: number } = {},
): Promise<{ prompt: string; negativePrompt?: string }> {
  const fallback = () => heuristicRefinementComposition(prev, refinement);
  let raw: string;
  try {
    raw = await complete(
      buildImageRefinementInput(prev.prompt, refinement),
      opts.timeoutMs ?? 30_000,
    );
  } catch {
    return fallback();
  }
  const parsed = parseImageRefinementReply(raw);
  if (!parsed) return fallback();
  // A reply that just echoes the refinement fragment carries no more
  // context than the status quo — treat as under-delivery.
  if (normalizeForComparison(parsed.prompt) === normalizeForComparison(refinement)) {
    return fallback();
  }
  const negativePrompt = mergeNegativePrompts(prev.negativePrompt, parsed.avoid);
  return {
    prompt: parsed.prompt,
    ...(negativePrompt ? { negativePrompt } : {}),
  };
}

/**
 * Extract the engine seed from a `generate_image` tool result summary
 * (`… image with <model> (seed 12345, 4 steps, 830ms) …`). Returns
 * undefined when the summary shape changes — seed threading silently
 * degrades to fresh-seed generations, never errors.
 */
export function extractGeneratedImageSeed(rawToolText: string): number | undefined {
  const m = /\(seed\s+(-?\d+)\b/.exec(rawToolText);
  if (!m?.[1]) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Extract the model id from the same summary line; informational only. */
export function extractGeneratedImageModel(rawToolText: string): string | undefined {
  const m = /image with\s+(\S+)\s+\(seed/.exec(rawToolText);
  return m?.[1] || undefined;
}

/**
 * Extract the artifact path from the tool summary's "call `read_artifact`
 * with path `…`" tail. Fallback for when the structured tool-call record
 * carries no image entries.
 */
export function extractGeneratedImageArtifactPath(rawToolText: string): string | undefined {
  const m = /read_artifact[^`]*`\s*with path\s+`([^`]+)`/.exec(rawToolText);
  return m?.[1] || undefined;
}

function mergeNegativePrompts(...parts: Array<string | undefined>): string | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const piece of part.split(',')) {
      const trimmed = piece.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.length > 0 ? out.join(', ') : undefined;
}

function stripWrappingQuotes(s: string): string {
  return s
    .replace(/^["'“”*]+/, '')
    .replace(/["'“”*]+$/, '')
    .trim();
}

function normalizeForComparison(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}
