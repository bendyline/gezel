import { z } from 'zod';

/**
 * A gezel's character: who they are to talk to, as opposed to what they do
 * (their role) or what they have learned (traits, lessons). Shown to the
 * model only when the person turns social mode on; every value has a concrete
 * effect on a turn (core/src/character/effects.ts), not just a tone.
 */
export const CHARACTER_TEMPERAMENTS = [
  'warm',
  'calm',
  'lively',
  'precise',
  'wry',
  'patient',
] as const;

export const CHARACTER_QUIRKS = [
  'curious',
  'tidy',
  'storyteller',
  'planner',
  'frugal',
  'cheerleader',
  'skeptic',
  'wordsmith',
  'rememberer',
  'punctual',
  'straight-shooter',
  'encourager',
] as const;

export const CHARACTER_STYLES = ['plain', 'playful', 'formal'] as const;

/** 0 keeps chat lines to a few words; 4 lets a gezel chat. */
export const CHARACTER_SOCIABILITY_MAX = 4;

export const GezelCharacterSchema = z.object({
  temperament: z.enum(CHARACTER_TEMPERAMENTS),
  quirk: z.enum(CHARACTER_QUIRKS),
  style: z.enum(CHARACTER_STYLES),
  sociability: z.number().int().min(0).max(CHARACTER_SOCIABILITY_MAX),
});
export type GezelCharacter = z.infer<typeof GezelCharacterSchema>;
export type CharacterTemperament = GezelCharacter['temperament'];
export type CharacterQuirk = GezelCharacter['quirk'];
export type CharacterStyle = GezelCharacter['style'];
