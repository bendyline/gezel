import { type CrewMember, type Task, taskPersonName } from '@bendyline/gezel';

/** "Trip Planner", "Planner", or nothing. */
function crewRoleLabel(member: CrewMember): string {
  if (!member.role) return '';
  return member.gloss ? `${member.role} — ${member.gloss}` : member.role;
}

/** "a", "a and b", "a, b and c". */
function joinNames(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * The words a crew introduction says, for the model and for any surface
 * that shows text rather than cards. Who joined and as what, never the step
 * they start on: `Minji (Office Administrator) starts with "First draft"`
 * read as a schedule in the plan's own words, and a small model repeated it
 * to the person word for word (2026-11-09).
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
    // The lead speaks for the crew: the person hears who asked for help,
    // not a roster change.
    if (opts.leadName) return `**${opts.leadName}** asked ${describe(m)} to help with ${what}.`;
    return `I've brought **${m.name}** onto the crew${label ? ` as your ${label}` : ''} for ${what}.`;
  }
  // At kickoff the one without a step to start is the task's lead.
  const parts = members.map((m) => (m.stepName ? describe(m) : `${describe(m)}, who leads it`));
  return `Your crew for ${what}: ${joinNames(parts)}.`;
}
