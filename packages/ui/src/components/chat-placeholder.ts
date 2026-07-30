import { type GezelGender, type GezelPronounForms, pronounFormsForGender } from '@bendyline/gezel';

/**
 * Compose a Squisq-editor placeholder for the chat composer. Different
 * roles get different hints:
 *
 *   - `meester` — the team concierge. Broad prompts about project ideas,
 *     catching up across work, spinning up gezels.
 *   - `voorman` — a project's foreman. Scoped to the project they run.
 *   - `other` — any other gezel. Short, worker-focused.
 *
 * A small pool of variants per role keeps the composer from feeling
 * repetitive between sessions; we pick one at mount time.
 */

export type ChatPlaceholderRole = 'meester' | 'voorman' | 'other';

interface Args {
  role: ChatPlaceholderRole;
  gezelName: string;
  /** Assigned gezel gender; absent legacy values use neutral they/them. */
  gezelGender?: GezelGender;
  /** Required for voorman role; ignored for others. */
  projectName?: string;
  /**
   * For fixed-function generator gezels: the MCP tool they forward to
   * (e.g. `'generate_image'`, `'generate_video'`). When set, the
   * composer gets a *directive* prompt that teaches the user how to
   * drive the generator instead of the conversational worker hints —
   * these gezels don't chat, they forward your text straight to one
   * tool. Overrides `role`.
   */
  fixedFunctionTool?: string;
}

type NamedVariant = (name: string, pronouns: GezelPronounForms) => string;

const MEESTER_VARIANTS: ReadonlyArray<NamedVariant> = [
  (name) =>
    `Talk with ${name} about project ideas, to catch up on existing projects, or to spin up a new gezel.`,
  (name) => `Ask ${name} what you should work on next — or just say what's on your mind.`,
  (name) =>
    `${name} knows the whole team. Ask what everyone's doing, delegate something new, or just vent about a stuck project.`,
  (name) =>
    `Got a half-baked idea? ${name} will help shape it into something your gezels can actually start on.`,
  (name, pronouns) =>
    `Ask ${name} who's working on what, or hand ${pronouns.object} something new to route.`,
];

const VOORMAN_VARIANTS: ReadonlyArray<
  (name: string, project: string, pronouns: GezelPronounForms) => string
> = [
  (name, project) => `Talk with ${name} about ${project}.`,
  (name, project) => `Ask ${name} how ${project} is going, nudge a stuck task, or rework the plan.`,
  (name, project, pronouns) =>
    `${name} runs ${project}. Check in on progress, change direction, or approve ${pronouns.possessiveAdjective} latest move.`,
  (name, project, pronouns) =>
    `What's blocking ${project}? Ask ${name} — ${pronouns.subject} will either know or can go find out.`,
  (name, project) => `Give ${name} a new brief for ${project}, or ask where the last thing landed.`,
];

const OTHER_VARIANTS: ReadonlyArray<NamedVariant> = [
  (name) => `Talk with ${name}.`,
  (name, pronouns) =>
    `Ask ${name} a question, hand ${pronouns.object} something to work on, or just see what ${pronouns.subject} ${pronouns.presentBe} up to.`,
  (name, pronouns) => `${name} is here when you need ${pronouns.object}. Fire away.`,
  (name, pronouns) =>
    `Catch ${name} up on what you want next, or ask what ${pronouns.subject} ${pronouns.presentHave} shipped.`,
];

/**
 * Directive prompts for fixed-function generator gezels. These gezels
 * forward your message text straight to one tool with no LLM in the
 * middle, so the copy teaches the user to *describe the thing* rather
 * than hold a conversation: keyword phrases over full sentences, with a
 * concrete example. Keyed by the gezel's `fixedFunction.tool`; anything
 * not listed falls back to GENERATOR_GENERIC.
 */
const GENERATOR_VARIANTS: Record<string, ReadonlyArray<(name: string) => string>> = {
  generate_image: [
    (name) =>
      `${name} only generates images. Describe the image you want exactly — e.g. "log cabin under a rainbow." No need for full sentences.`,
    (name) =>
      `${name} turns a description into an image. Just list what you want to see — "neon city street at night, rain" — keywords are fine.`,
  ],
  generate_video: [
    (name) =>
      `${name} only generates video. Describe the shot you want exactly — e.g. "drone flyover of a snowy forest." No need for full sentences.`,
    (name) =>
      `${name} turns a description into a clip. Just list what you want to see — "waves crashing on rocks at sunset" — keywords are fine.`,
  ],
};

const GENERATOR_GENERIC: ReadonlyArray<(name: string) => string> = [
  (name) =>
    `${name} forwards whatever you type straight to one tool — there's no chat in the middle. Describe exactly what you want; keywords are fine.`,
];

const QUIRKY_UNIVERSAL: ReadonlyArray<NamedVariant> = [
  (name) => `Go ahead, ${name} is listening.`,
  (name, pronouns) => `${name} has been waiting patiently. Ask ${pronouns.object} anything.`,
  (name) => `No wrong questions. ${name} has probably heard weirder.`,
  (name) => `Don't be shy — ${name} has seen it all.`,
];

/**
 * Pick a random placeholder from the role's pool. The universal-quirky
 * pool is mixed in at a low rate so the composer occasionally surprises
 * the user without drowning out the role-specific hints.
 */
export function pickChatPlaceholder(args: Args): string {
  const { role, gezelName } = args;
  const pronouns = pronounFormsForGender(args.gezelGender);
  // Fixed-function generators get directive copy and skip the quirky/
  // conversational pools entirely — "ask them anything" is misleading
  // for a gezel that only forwards text to one tool.
  if (args.fixedFunctionTool) {
    const pool = GENERATOR_VARIANTS[args.fixedFunctionTool] ?? GENERATOR_GENERIC;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return sentenceCase(pick ? pick(gezelName) : GENERATOR_GENERIC[0]!(gezelName));
  }
  // ~15% chance to serve a quirky universal variant, regardless of role.
  if (Math.random() < 0.15) {
    const q = QUIRKY_UNIVERSAL[Math.floor(Math.random() * QUIRKY_UNIVERSAL.length)];
    if (q) return sentenceCase(q(gezelName, pronouns));
  }
  if (role === 'meester') {
    const pick = MEESTER_VARIANTS[Math.floor(Math.random() * MEESTER_VARIANTS.length)];
    return sentenceCase(pick ? pick(gezelName, pronouns) : `Talk with ${gezelName}.`);
  }
  if (role === 'voorman') {
    const project = args.projectName ?? 'this project';
    const pick = VOORMAN_VARIANTS[Math.floor(Math.random() * VOORMAN_VARIANTS.length)];
    return sentenceCase(
      pick ? pick(gezelName, project, pronouns) : `Talk with ${gezelName} about ${project}.`,
    );
  }
  const pick = OTHER_VARIANTS[Math.floor(Math.random() * OTHER_VARIANTS.length)];
  return sentenceCase(pick ? pick(gezelName, pronouns) : `Talk with ${gezelName}.`);
}

/**
 * Placeholders are sentences, and several templates open with the gezel's
 * name — which can be a lowercase fallback like "your meester". Capitalize
 * the first character so the sentence never starts lowercase, wherever the
 * name lands in the template.
 */
function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
