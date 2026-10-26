import type { CrewIntroduction, GezelSummary } from '@bendyline/gezel';
import { CrewMemberCard } from './CrewMemberCard.js';

/**
 * The crew a task brought, introduced in the thread that launched it: one
 * card per gezel with their portrait, their role in plain words ("Trip
 * Planner"), what they start with, and a way to say hello. It replaced a line of prose that named people the reader
 * had never met and could not see.
 */
export function CrewIntroCard({
  intro,
  gezels,
  dataMsgId,
  dataSessionId,
  extraClass,
}: {
  intro: CrewIntroduction;
  gezels?: ReadonlyMap<string, GezelSummary>;
  dataMsgId?: string;
  dataSessionId?: string;
  extraClass?: string;
}) {
  const lead = intro.moment === 'kickoff' ? 'Your crew' : 'Joined the crew';
  return (
    <aside
      className={`msg msg-crew-intro${extraClass ? ` ${extraClass}` : ''}`}
      data-msg-id={dataMsgId}
      data-session-id={dataSessionId}
      data-testid="crew-intro"
      aria-label={lead}
    >
      <p className="msg-crew-intro-lead">{lead}</p>
      <ul className="msg-crew-intro-cards">
        {intro.members.map((member) => (
          <CrewMemberCard
            key={member.gezelId}
            member={member}
            gezel={gezels?.get(member.gezelId)}
          />
        ))}
      </ul>
    </aside>
  );
}
