/** Shared safeguards for project-kickoff tool loops across local and remote sessions. */

/** Redundant calls tolerated after a successful kickoff before forcing end-of-turn. */
export const PROJECT_MACRO_INTERCEPT_CAP = 2;

/** Failed kickoff calls tolerated before returning a visible failure to the user. */
export const PROJECT_MACRO_FAILURE_CAP = 2;

/** Derive a concise user-facing closing from a successful kickoff result. */
export function deriveProjectMacroClosing(firstResult: string): string {
  const projectMatch = firstResult.match(/Started (?:project|job) "([^"]+)"/);
  // "voorman" is what results said before the crew lead was renamed.
  const leadMatch = firstResult.match(/Recruited (\S+) as (crew lead|voorman|builder|lead)/i);
  const projectName = projectMatch?.[1];
  const leadName = leadMatch?.[1];
  const leadRole = leadMatch?.[2]?.toLowerCase();
  if (projectName && leadName) {
    const crewLead = leadRole === 'crew lead' || leadRole === 'voorman';
    const trailer = crewLead ? ' is leading the crew' : ' is on it';
    return `Project "${projectName}" is kicked off — ${leadName}${trailer}. You can watch their work surface in this thread.`;
  }
  if (projectName) {
    return `Project "${projectName}" is kicked off — the lead is taking it from here.`;
  }
  return 'Project kickoff is on it — the lead is taking it from here.';
}
