/**
 * The chat composer's placeholder: one sentence per kind of conversation.
 *
 *   - `meester` — the front door: say what you want done, or ask how it goes.
 *   - `voorman` — a project's crew lead, scoped to the project they run.
 *   - `other` — any other crew member.
 *
 * One fixed sentence per place, never a random pick. A pool of variants
 * re-rolled whenever the recipient's details loaded, so one Home visit
 * showed five different hints. The sentences name the crew member and use
 * no pronoun: a gender that has not loaded yet read as "them" in one hint
 * and "her" in the next, for the same person.
 */

export type ChatPlaceholderRole = 'meester' | 'voorman' | 'other';

interface Args {
  role: ChatPlaceholderRole;
  gezelName: string;
  /** Required for voorman role; ignored for others. */
  projectName?: string;
  /**
   * For fixed-function generator gezels: the MCP tool they forward to
   * (e.g. `'generate_image'`, `'generate_video'`). When set, the
   * composer gets a *directive* prompt that teaches the user how to
   * drive the generator instead of the conversational hint — these
   * gezels don't chat, they forward your text straight to one tool.
   * Overrides `role`.
   */
  fixedFunctionTool?: string;
  /**
   * The fixed-function gezel needs an attached picture (`requiresInputImage`):
   * an image gezel edits it, a video gezel animates it.
   */
  fixedFunctionEdits?: boolean;
}

/**
 * Directive prompts for fixed-function generator gezels. These gezels
 * forward your message text straight to one tool with no LLM in the
 * middle, so the copy teaches the user to *describe the thing* rather
 * than hold a conversation: keyword phrases over full sentences, with a
 * concrete example. Keyed by the gezel's `fixedFunction.tool`; anything
 * not listed falls back to GENERATOR_GENERIC.
 */
const GENERATOR_HINTS: Record<string, (name: string) => string> = {
  generate_image: (name) =>
    `${name} only generates images. Describe the image you want exactly — e.g. "log cabin under a rainbow." No need for full sentences.`,
  generate_video: (name) =>
    `${name} only generates video. Describe the shot you want exactly — e.g. "drone flyover of a snowy forest." No need for full sentences.`,
  // A video gezel set to animate only: a picture plus how it should move.
  animate_video: (name) =>
    `Attach a picture and tell ${name} how it should move — e.g. "the camera drifts closer."`,
  // An image editor's message is a picture plus what to change about it.
  edit_image: (name) =>
    `Attach a picture and tell ${name} what to change — e.g. "make the sky a sunset."`,
};

const GENERATOR_GENERIC = (name: string) =>
  `${name} forwards whatever you type straight to one tool — there's no chat in the middle. Describe exactly what you want; keywords are fine.`;

/** The placeholder for this conversation. The same arguments always give the same sentence. */
export function pickChatPlaceholder(args: Args): string {
  const { role, gezelName } = args;
  // Fixed-function generators get directive copy: "ask them anything" is
  // misleading for a gezel that only forwards text to one tool.
  if (args.fixedFunctionTool) {
    const key = !args.fixedFunctionEdits
      ? args.fixedFunctionTool
      : args.fixedFunctionTool === 'generate_video'
        ? 'animate_video'
        : 'edit_image';
    return sentenceCase((GENERATOR_HINTS[key] ?? GENERATOR_GENERIC)(gezelName));
  }
  if (role === 'meester') {
    return sentenceCase(
      `Tell ${gezelName} what you want to get done, or ask how things are going.`,
    );
  }
  if (role === 'voorman') {
    const project = args.projectName ?? 'this project';
    return sentenceCase(`Ask ${gezelName} how ${project} is going, or hand over something new.`);
  }
  return sentenceCase(`Ask ${gezelName} a question, or hand over something to work on.`);
}

/**
 * The composer's hint while a task the person picked is attached. Send starts
 * the task with the draft as its brief, so the box is for anything the plan's
 * settings did not already say.
 */
export function taskLaunchPlaceholder(taskName: string): string {
  return `Enter any further instructions here for your ${taskName}. Click the ↑ icon to start.`;
}

/**
 * Placeholders are sentences, and several open with the gezel's name — which
 * can be a lowercase fallback like "your meester". Capitalize each sentence's
 * first character so it never starts lowercase, wherever the name lands.
 * Abbreviations are not sentence boundaries.
 */
function sentenceCase(s: string): string {
  const abbreviationAtEnd = /\b(?:e\.g|i\.e|etc|vs|approx|no|fig|Mr|Mrs|Ms|Dr|St)\.$/iu;

  return s.replace(
    /(^|[.?!]["')\]]?\s+)(["'(\[]*)(\p{Ll})/gu,
    (match, boundary: string, openingPunctuation: string, letter: string, offset: number) => {
      if (boundary.startsWith('.') && abbreviationAtEnd.test(s.slice(0, offset + 1))) {
        return match;
      }
      return `${boundary}${openingPunctuation}${letter.toUpperCase()}`;
    },
  );
}
