/**
 * Plain-English role titles, and the Dutch titles they replaced.
 *
 * The guild once titled its crew in Dutch — Voorman, Boekwachter,
 * Reisleider — and glossed each one in plain words. A newcomer met a crew of
 * Ceremoniemeesters with no way to know who did what, so the titles a person
 * reads are now plain English. The Meester is the one Dutch title kept.
 *
 * Code still knows these roles by their Dutch keys (`voorman`,
 * `boekwachter`, the gilde template ids, config keys), and older installs,
 * older catalog lines and models trained on older prompts still write them.
 * So a Dutch title and its English replacement are the same role to every
 * predicate: route role text through {@link roleForMatching} before testing
 * it, and a rename can never change a gezel's tool kit or how it is matched.
 *
 * English titles must stay unique, and must not equal a role that already
 * means something else (an existing gilde role, a matcher alias such as
 * "manager" or "wordsmith") — the parity tests pin both.
 */
const PLAIN_ROLE_TITLES: Readonly<Record<string, string>> = {
  voorman: 'Crew Lead',
  boekwachter: 'Librarian',
  klerk: 'Scribe',
  keurmeester: 'Inspector',
  reisleider: 'Trip Planner',
  ceremoniemeester: 'Event Planner',
  zorgcoordinator: 'Care Coordinator',
  archivaris: 'Archivist',
  maaltijdplanner: 'Meal Planner',
  penningmeester: 'Household Treasurer',
  huismeester: 'Home Keeper',
  kantoormeester: 'Office Administrator',
  aanjager: 'Fundraiser',
  schrijfmaat: 'Writing Partner',
  studiemaat: 'Study Partner',
  loopbaancoach: 'Career Coach',
  'oefen-interviewer': 'Mock Interviewer',
  omroeper: 'Social Media Writer',
  woordsmid: 'Clue Giver',
  puzzelaar: 'Puzzler',
  damspeler: 'Checkers Player',
  schaakspeler: 'Chess Player',
  'go-speler': 'Go Player',
  tekenaar: 'Character Artist',
  assetsmid: 'Game Asset Artist',
  verhalenverteller: 'Storyteller',
  werkmeester: 'Video Editor',
  regisseur: 'Film Director',
  filmarchivaris: 'Film Archivist',
  huisautomaat: 'Home Automator',
  spellenmaker: 'Game Maker',
};

function roleKey(role: string): string {
  return role.trim().toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
}

const LEGACY_KEY_BY_PLAIN_TITLE: ReadonlyMap<string, string> = new Map(
  Object.entries(PLAIN_ROLE_TITLES).map(([legacy, plain]) => [roleKey(plain), legacy]),
);

/** Every Dutch title with its plain-English replacement, keyed by the Dutch title. */
export function legacyRoleTitles(): Readonly<Record<string, string>> {
  return PLAIN_ROLE_TITLES;
}

/**
 * The Dutch key for a role written either way: "Voorman" and "Crew Lead"
 * both give `voorman`. Undefined for any other role, including one that
 * merely contains a title ("Senior Voorman").
 */
export function legacyRoleKey(role: string | undefined): string | undefined {
  if (!role?.trim()) return undefined;
  const key = roleKey(role);
  if (key in PLAIN_ROLE_TITLES) return key;
  return LEGACY_KEY_BY_PLAIN_TITLE.get(key);
}

/**
 * The text every role predicate should test: the Dutch key for a renamed
 * title, otherwise the role as given.
 */
export function roleForMatching(role: string): string;
export function roleForMatching(role: string | undefined): string | undefined;
export function roleForMatching(role: string | undefined): string | undefined {
  return legacyRoleKey(role) ?? role;
}

/** True for a Dutch title that has a plain-English replacement ("Voorman"). */
export function isLegacyRoleTitle(role: string | undefined): boolean {
  return Boolean(role?.trim()) && roleKey(role!) in PLAIN_ROLE_TITLES;
}

/** "Trip Planner" for "Reisleider"; any other role comes back trimmed. */
export function plainRoleTitle(role: string): string {
  const key = roleKey(role);
  return PLAIN_ROLE_TITLES[key] ?? role.trim();
}

const ACCENTED: Readonly<Record<string, string>> = {
  a: '[aáàäâ]',
  e: '[eéèëê]',
  i: '[iíìïî]',
  o: '[oóòöô]',
  u: '[uúùüû]',
};

/**
 * A gezel's about.md written with its own Dutch title in plain English: "You
 * are a reisleider — …" reads "You are a trip planner — …", and "the
 * **Klerk**" reads "the **Scribe**". Only that one title moves, in the case
 * it was written, with a/an agreeing; the rest of the prose is the person's.
 */
export function plainRoleProse(text: string, role: string | undefined): string {
  const key = legacyRoleKey(role);
  if (!key || !text) return text;
  const plain = PLAIN_ROLE_TITLES[key]!;
  // Keys are letters and hyphens; a bare hyphen is literal outside a class.
  const word = [...key].map((ch) => ACCENTED[ch] ?? ch).join('');
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:(a|an)(\s+(?:\*\*)?))?(${word})(?![\p{L}\p{N}])`,
    'giu',
  );
  return text.replace(
    pattern,
    (_match, article: string | undefined, gap: string, found: string) => {
      const title =
        found === found.toUpperCase()
          ? plain.toUpperCase()
          : found[0] === found[0]!.toUpperCase()
            ? plain
            : plain.toLowerCase();
      if (!article) return title;
      const an = /^[aeiou]/i.test(plain) ? 'an' : 'a';
      const cased =
        article[0] === article[0]!.toUpperCase() ? an[0]!.toUpperCase() + an.slice(1) : an;
      return `${cased}${gap}${title}`;
    },
  );
}

/** @deprecated Roles are plain English now; there is nothing to gloss. */
export function roleGloss(_role: string | undefined): string | undefined {
  return undefined;
}

/** @deprecated Use {@link plainRoleTitle}. */
export function roleWithGloss(role: string): string {
  return plainRoleTitle(role);
}
