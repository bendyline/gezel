import type { NativeToolListing } from './tools/native-tools.js';

/**
 * How much standing prompt and tool description a model is given: one decision
 * shared by the desktop prompt builder and the portable (mobile) runtime, so a
 * "small model" means the same thing on every host.
 *
 * - `standard`: the full stack; tier behaviors still tune it (docs/prompt-stack.md).
 * - `compact`: a model that can hold the stack but reads it slowly. Every prompt
 *   token is prefill time on a phone: a Galaxy S20 FE spent 142 s reading gezel's
 *   ~3,000-token standard prompt before Qwen 3.5 2B wrote a word (2026-09-26).
 * - `minimal`: a window that cannot hold the standard stack at all.
 */
export type PromptFootprint = 'standard' | 'compact' | 'minimal';

/** Windows at or below this take the minimal footprint. */
export const MINIMAL_FOOTPRINT_MAX_WINDOW = 4096;

export interface PromptFootprintInput {
  /** The window the model actually runs with (after host clamps). */
  contextWindow?: number;
  /** Inference runs on phone or tablet hardware, where prefill is slow. */
  constrainedDevice?: boolean;
  /** An explicit choice (a profile behavior or setting) wins. */
  requested?: PromptFootprint;
}

export function resolvePromptFootprint(input: PromptFootprintInput): PromptFootprint {
  if (input.requested) return input.requested;
  const window = input.contextWindow;
  if (window !== undefined && window > 0 && window <= MINIMAL_FOOTPRINT_MAX_WINDOW)
    return 'minimal';
  return input.constrainedDevice ? 'compact' : 'standard';
}

/** What a footprint allows. Hosts read this rather than keeping their own numbers. */
export interface PromptFootprintPolicy {
  /** Cap on the gezel's about.md, cut at a sentence; absent keeps it whole. */
  aboutMaxChars?: number;
  /**
   * Cap on the project brief (about + mission objectives); absent keeps it
   * whole. A session that can act on the project keeps a brief at every
   * footprint: the brief is what makes a project more than a folder.
   */
  projectBriefMaxChars?: number;
  /** Where a text tool listing starts; it still narrows when the model refuses it. */
  textToolListing: 'full' | 'compact' | 'signatures';
  /** Where native tool definitions start; they narrow the same way. */
  nativeToolListing: NativeToolListing;
}

export const PROMPT_FOOTPRINT_POLICY: Readonly<Record<PromptFootprint, PromptFootprintPolicy>> = {
  standard: { textToolListing: 'full', nativeToolListing: 'full' },
  compact: {
    aboutMaxChars: 1500,
    projectBriefMaxChars: 1200,
    textToolListing: 'compact',
    nativeToolListing: 'compact',
  },
  minimal: {
    aboutMaxChars: 900,
    projectBriefMaxChars: 600,
    textToolListing: 'compact',
    nativeToolListing: 'compact',
  },
};

function condense(text: string, maxChars: number | undefined, note: string): string {
  if (maxChars === undefined || text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const boundary = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
  const kept = (boundary > maxChars * 0.5 ? slice.slice(0, boundary + 1) : slice).trim();
  return `${kept}\n\n${note}`;
}

/** Trims about.md to a sentence boundary under `maxChars`, saying that it did. */
export function capAboutForFootprint(about: string, maxChars: number | undefined): string {
  return condense(about, maxChars, "(About condensed to fit this model's small context window.)");
}

/**
 * The project's about and mission objectives as prompt sections, each cut at a
 * sentence when a cap applies (half the cap each when both are present).
 */
export function renderProjectBrief(
  project: { about?: string; missionObjectives?: string },
  maxChars: number | undefined,
): string {
  const sections = [
    ['About this project', project.about?.trim()],
    ['Mission objectives', project.missionObjectives?.trim()],
  ].filter((section): section is [string, string] => !!section[1]);
  const share =
    maxChars === undefined ? undefined : Math.floor(maxChars / Math.max(1, sections.length));
  return sections
    .map(([heading, text]) => `### ${heading}\n${condense(text, share, '(Condensed.)')}`)
    .join('\n\n');
}
