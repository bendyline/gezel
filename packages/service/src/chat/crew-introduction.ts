import { type CrewMember, type Task, taskPersonName } from '@bendyline/gezel';

/** "Reisleider — trip planner", "Planner", or nothing. */
function crewRoleLabel(member: CrewMember): string {
  if (!member.role) return '';
  return member.gloss ? `${member.role} — ${member.gloss}` : member.role;
}

/**
 * The words a crew introduction says, for the model and for any surface
 * that shows text rather than cards.
 */
export function crewIntroductionText(
  task: Pick<Task, 'title'> & { craftbook?: Pick<Task['craftbook'], 'id' | 'name'> },
  members: readonly CrewMember[],
  moment: 'kickoff' | 'joined',
  opts: { leadName?: string } = {},
): string {
  const describe = (m: CrewMember) => {
    const label = crewRoleLabel(m);
    return `**${m.name}**${label ? ` (${label})` : ''}`;
  };
  const name = taskPersonName(task);
  const what = name ? `**${name}**` : 'this';
  if (moment === 'joined') {
    const m = members[0]!;
    const label = crewRoleLabel(m);
    const starts = m.stepName ? ` ${m.name} starts with "${m.stepName}".` : '';
    // The lead speaks for the crew: the person hears who asked for help,
    // not a roster change.
    if (opts.leadName)
      return `**${opts.leadName}** asked ${describe(m)} to help with ${what}.${starts}`;
    return `I've brought **${m.name}** onto the crew${label ? ` as your ${label}` : ''} for ${what}.${starts}`;
  }
  const parts = members.map((m) =>
    m.stepName ? `${describe(m)} starts with "${m.stepName}"` : `${describe(m)} leads it`,
  );
  return `Your crew for ${what}: ${parts.join(', and ')}.`;
}
