import {
  CHARACTER_QUIRKS,
  CHARACTER_SOCIABILITY_MAX,
  CHARACTER_STYLES,
  CHARACTER_TEMPERAMENTS,
  type CharacterQuirk,
  type CharacterStyle,
  type CharacterTemperament,
  type GezelCharacter,
} from '../schemas/character.js';

/**
 * What one character value does to a turn. Every value has a line the model
 * reads; a value that only changed tone would not be accepted.
 */
export interface CharacterEffect {
  line: string;
  /** Scales how long replies aim to be; absent leaves the length alone. */
  lengthFactor?: number;
}

export const TEMPERAMENT_EFFECTS: Readonly<Record<CharacterTemperament, CharacterEffect>> = {
  warm: { line: 'Open by acknowledging the person before getting to work.' },
  calm: { line: 'Keep an even tone; replies about a fifth shorter than usual.', lengthFactor: 0.8 },
  lively: {
    line: 'Bring energy; replies may run a little longer, and an exclamation is fine.',
    lengthFactor: 1.2,
  },
  precise: { line: 'Before you send, check names, numbers and dates.' },
  wry: { line: 'One light aside per reply is welcome, never at the person’s expense.' },
  patient: { line: 'One thing at a time, and at most one question per reply.' },
};

export const QUIRK_EFFECTS: Readonly<Record<CharacterQuirk, CharacterEffect>> = {
  curious: { line: 'You may end with one follow-up question.' },
  tidy: { line: 'End with a one-line recap.' },
  storyteller: { line: 'You may add one short example.' },
  planner: { line: 'Suggest the next step at the end.' },
  frugal: { line: 'Use the fewest words that do the job.', lengthFactor: 0.7 },
  cheerleader: { line: 'When a score or result improves, say so.' },
  skeptic: { line: 'When you are unsure, say so plainly.' },
  wordsmith: { line: 'Offer one useful word or phrase when it helps.' },
  rememberer: { line: 'Bring up an earlier note when it applies.' },
  punctual: { line: 'Mention dates and deadlines when they matter.' },
  'straight-shooter': { line: 'Lead with the answer; reasons after.' },
  encourager: { line: 'Close on one specific thing that went well.' },
};

export const STYLE_EFFECTS: Readonly<Record<CharacterStyle, CharacterEffect>> = {
  plain: { line: 'Speak plainly.' },
  playful: { line: 'Keep it playful.' },
  formal: { line: 'Keep it courteous and formal.' },
};

/** Words in a short chat line (a turn tool's `say`), by sociability 0–4. */
export const SOCIABILITY_CHAT_WORDS = [6, 12, 20, 35, 55] as const;

export function sociabilityEffect(sociability: number): CharacterEffect {
  const level = Math.max(0, Math.min(CHARACTER_SOCIABILITY_MAX, Math.round(sociability)));
  return { line: `Small talk: about ${SOCIABILITY_CHAT_WORDS[level]} words at most.` };
}

/** How much a character scales reply length, from its temperament and quirk. */
export function characterLengthFactor(character: GezelCharacter): number {
  return (
    (TEMPERAMENT_EFFECTS[character.temperament].lengthFactor ?? 1) *
    (QUIRK_EFFECTS[character.quirk].lengthFactor ?? 1)
  );
}

/** djb2, the family the poppetje and voice seeds use: one id, one character, always. */
function seedOf(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return hash >>> 0;
}

/**
 * The character a gezel is born with, derived from its id. Persisted on
 * creation like the poppetje: adding values later must not change anyone
 * who already exists, so the stored record wins over a re-derived one.
 */
export function seedCharacter(gezelId: string): GezelCharacter {
  const roll = (field: string, sides: number) => seedOf(`character:${field}:${gezelId}`) % sides;
  return {
    temperament: CHARACTER_TEMPERAMENTS[roll('temperament', CHARACTER_TEMPERAMENTS.length)]!,
    quirk: CHARACTER_QUIRKS[roll('quirk', CHARACTER_QUIRKS.length)]!,
    style: CHARACTER_STYLES[roll('style', CHARACTER_STYLES.length)]!,
    sociability: roll('sociability', CHARACTER_SOCIABILITY_MAX + 1),
  };
}

/**
 * The `### Character` block: one line per value, in the stable band beside
 * the gezel's traits. Rendered only in social mode; kept at every footprint.
 */
export function renderCharacterBlock(character: GezelCharacter | undefined): string {
  if (!character) return '';
  const lines = [
    `${STYLE_EFFECTS[character.style].line} ${TEMPERAMENT_EFFECTS[character.temperament].line}`,
    QUIRK_EFFECTS[character.quirk].line,
    sociabilityEffect(character.sociability).line,
  ];
  return `\n\n---\n\n### Character\n\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

/** Which host is asking: phones default to social mode, the desktop does not. */
export type SocialHost = 'desktop' | 'phone';

/** Whether social mode is on: the person's choice, else the host's default. */
export function resolveSocialMode(config: { social?: boolean }, host: SocialHost): boolean {
  return config.social ?? host === 'phone';
}

/**
 * A turn tool's visible chat line (its `say` argument), capped by
 * sociability: about eight characters a word, scaled by the temperament and
 * quirk's length factor, never under 60. Without a character (social mode
 * off) the policy is unchanged.
 */
export function withCharacterChatCap<T extends { maxClosingChars?: number }>(
  policy: T,
  character: GezelCharacter | undefined,
): T {
  if (!character) return policy;
  const level = Math.max(0, Math.min(CHARACTER_SOCIABILITY_MAX, character.sociability));
  const cap = Math.max(
    60,
    Math.round(SOCIABILITY_CHAT_WORDS[level]! * 8 * characterLengthFactor(character)),
  );
  return { ...policy, maxClosingChars: Math.min(policy.maxClosingChars ?? cap, cap) };
}
