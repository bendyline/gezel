/**
 * Pronunciation that depends on the neighbouring words.
 *
 * misaki, Kokoro's reference frontend, tags every word's part of speech and
 * picks among per-tag readings: "present" is a verb in "we present the deck"
 * and a noun in "at present". A tagger is too heavy to ship here, and only
 * about seven hundred words need one, so these rules read the words beside
 * each of them instead. The commonest frames are unambiguous: a determiner or
 * preposition introduces a noun, a subject or auxiliary introduces a verb, and
 * a linking verb introduces an adjective. Anything else keeps the default.
 *
 * The same neighbours decide how the short function words are said, as misaki
 * says them: "the" is "thuh" before a consonant and "thee" before a vowel.
 */

import { type KokoroSense, startsWithVowelSound } from './lexicon.js';

/** The words beside one word, lowercased; absent across punctuation. */
export interface KokoroNeighbours {
  readonly previous?: string;
  readonly beforePrevious?: string;
  readonly next?: string;
  readonly afterNext?: string;
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(' '));

/** Determiners, prepositions and a few adjectives that are followed by a noun. */
const BEFORE_NOUN = words(
  "the a an this these those my your his her our their its some any no every each all both either neither another such what whose many much several few fewer more most enough other same own new old last final current previous entire whole original existing main great good full real there's here's of in on at for with from by about into onto over under without within through throughout between among across against during after before behind beyond below above near per via like unlike as than toward towards upon despite except including regarding",
);

/** Subjects, auxiliaries and modals, which are followed by a verb. */
const BEFORE_VERB = words(
  "i we you they he she it who will would can could shall should may might must do does did don't doesn't didn't won't wouldn't can't cannot couldn't shouldn't mustn't please let's i'll we'll you'll they'll he'll she'll it'll i'd we'd you'd they'd he'd she'd",
);

/** Linking verbs and degree words: what follows describes, so it reads as an adjective. */
const BEFORE_ADJECTIVE = words(
  "is am are was were be been being isn't aren't wasn't weren't i'm you're we're they're it's he's she's that's what's who's seem seems seemed feel feels felt remain remains remained become becomes became stay stays stayed very quite so too perfectly fairly rather extremely completely entirely",
);

/** Perfect auxiliaries: a participle follows ("have read"), or else a noun. */
const BEFORE_PARTICIPLE = words(
  "have has had having haven't hasn't hadn't i've we've you've they've could've would've should've must've",
);

/** Words that open a verb's object: "present the deck", "record it". */
const OBJECTS = words(
  'the a an this these those my your his her our their its them him me us it you yourself yourselves itself himself herself themselves ourselves myself each every both some any someone something everyone everything anyone anything',
);

/** Adverbs that sit inside a verb phrase; the word before them decides ("will also present"). */
const SKIPPED = words(
  'not also always never often usually sometimes still just only already simply then now first',
);

/** Heads that take "to" and then a noun: "access to content", "due to progress". */
const TO_NOUN = words(
  'due according next close thanks similar related relative access compared prior addition contribute contributes contributed contributing changes respect regard back return attention',
);

/** Verbs that make "used to" a habit: "get used to it". */
const GET = words('get gets got getting gotten become becomes became');

function isPossessive(word: string): boolean {
  return /['’]s$|s['’]$/u.test(word);
}

function fromPrevious(
  word: string,
  previous: string | undefined,
  beforePrevious: string | undefined,
  next: string | undefined,
): KokoroSense[] | undefined {
  if (previous === undefined) return undefined;
  if (SKIPPED.has(previous)) {
    if (beforePrevious !== undefined) return fromPrevious(word, beforePrevious, undefined, next);
    // A sentence opening on an adverb is an instruction: "Then present it."
    return previous === 'not' ? undefined : ['VERB'];
  }
  // "that" and "which" are determiners before a noun and pronouns before a verb,
  // and the verb after a singular pronoun ends in -s: "a tool that records".
  if (previous === 'that' || previous === 'which')
    return /[^s]s$/u.test(word) ? ['VERB'] : ['NOUN'];
  if (previous === 'to') {
    if (next !== undefined && OBJECTS.has(next)) return ['VERB'];
    return beforePrevious !== undefined && TO_NOUN.has(beforePrevious) ? ['NOUN'] : ['VERB'];
  }
  if (BEFORE_NOUN.has(previous)) return ['NOUN'];
  if (BEFORE_ADJECTIVE.has(previous)) return ['ADJ', 'VBN'];
  if (BEFORE_PARTICIPLE.has(previous)) return ['VBN', 'VBD', 'NOUN'];
  if (BEFORE_VERB.has(previous)) return ['VERB'];
  if (isPossessive(previous)) return ['NOUN'];
  return undefined;
}

function fromNext(word: string, next: string | undefined): KokoroSense[] | undefined {
  if (next === undefined) return undefined;
  if (next === 'of') return ['NOUN'];
  if (word === 'use' && (next === 'case' || next === 'cases')) return ['NOUN'];
  if (OBJECTS.has(next)) return ['VERB'];
  return undefined;
}

/**
 * The uses `word` (lowercased) most likely has here, best first. An empty list
 * means no cue: the word keeps its default reading.
 */
export function senseCues(word: string, around: KokoroNeighbours): KokoroSense[] {
  const { previous, beforePrevious, next, afterNext } = around;
  if (word === 'used' && next === 'to') {
    // "I used to" and "get used to it" are a habit ("yoost"); "is used to
    // build" is the passive and keeps the default ("yoozd").
    const subject = previous !== undefined && SKIPPED.has(previous) ? beforePrevious : previous;
    const habit =
      subject === undefined ||
      BEFORE_VERB.has(subject) ||
      GET.has(subject) ||
      (BEFORE_ADJECTIVE.has(subject) &&
        afterNext !== undefined &&
        (OBJECTS.has(afterNext) || afterNext.endsWith('ing')));
    return habit ? ['VBD'] : [];
  }
  const cues = fromPrevious(word, previous, beforePrevious, next) ?? fromNext(word, next) ?? [];
  // At the end of a phrase a function word is stressed ("yes, we can"), and a
  // few words read as adverbs ("Overall, ...").
  if (next === undefined) return cues.length ? [...cues, 'FINAL'] : ['FINAL', 'ADV'];
  return cues;
}

/**
 * How a short function word is said before `next` (the next word's phonemes,
 * absent at the end of a phrase), or undefined to keep the dictionary's
 * reading. Case matters: "A" alone is the letter unless it opens the phrase.
 */
export function reducedFunctionWord(
  word: string,
  next: string | undefined,
  opensPhrase: boolean,
): string | undefined {
  switch (word) {
    case 'the':
    case 'The':
      return next !== undefined && startsWithVowelSound(next) ? 'ði' : 'ðə';
    case 'to':
    case 'To':
      if (next === undefined) return undefined;
      return startsWithVowelSound(next) ? 'tʊ' : 'tə';
    case 'a':
      return next === undefined ? 'ˈA' : 'ɐ';
    case 'A':
      return opensPhrase && next !== undefined ? 'ɐ' : 'ˈA';
    case 'an':
    case 'An':
      return 'ɐn';
    case 'am':
    case 'Am':
      return next === undefined ? undefined : 'ɐm';
    case 'in':
    case 'In':
      return next === undefined ? 'ˈɪn' : 'ɪn';
    case 'I':
      return 'ˌI';
    default:
      return undefined;
  }
}
