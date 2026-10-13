/**
 * Plain words beside the guild's Dutch role names.
 *
 * "Reisleider" is part of the charm and tells a newcomer nothing; the UX
 * review met a crew of Ceremoniemeesters and Voormannen with no way to know
 * who did what. Shown together — "Reisleider — trip planner" — the name keeps
 * its character and the person keeps their bearings. Roles that are already
 * plain English (Planner, Researcher) carry no gloss.
 */
const ROLE_GLOSSES: Readonly<Record<string, string>> = {
  meester: 'runs the workshop',
  voorman: 'crew lead',
  boekwachter: 'keeps track of your files',
  klerk: 'handles the paperwork',
  keurmeester: 'quality inspector',
  veiligheidsmeester: 'security',
  reisleider: 'trip planner',
  ceremoniemeester: 'event planner',
  zorgcoordinator: 'care coordinator',
  archivaris: 'archivist',
  maaltijdplanner: 'meal planner',
  penningmeester: 'household treasurer',
  huismeester: 'home keeper',
  kantoormeester: 'office manager',
  aanjager: 'fundraiser',
  schrijfmaat: 'writing partner',
  studiemaat: 'study partner',
  loopbaancoach: 'career coach',
  'oefen-interviewer': 'mock interviewer',
  omroeper: 'social posts',
  woordsmid: 'clue giver',
  puzzelaar: 'clue giver',
  damspeler: 'checkers player',
  schaakspeler: 'chess player',
  'go-speler': 'Go player',
};

function roleKey(role: string): string {
  return role.trim().toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
}

/** "trip planner" for "Reisleider"; undefined for a role that is plain already. */
export function roleGloss(role: string | undefined): string | undefined {
  if (!role?.trim()) return undefined;
  return ROLE_GLOSSES[roleKey(role)];
}

/** "Reisleider — trip planner", or the role alone. */
export function roleWithGloss(role: string): string {
  const gloss = roleGloss(role);
  return gloss ? `${role.trim()} — ${gloss}` : role.trim();
}
