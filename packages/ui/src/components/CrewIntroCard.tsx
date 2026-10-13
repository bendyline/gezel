import type { CrewIntroduction, GezelSummary } from '@bendyline/gezel';
import { GezelIcon } from './GezelIcon.js';
import { navigateToTab } from './nav-actions.js';

/**
 * The crew a task brought, introduced in the thread that launched it: one
 * card per gezel with their portrait, their role in plain words beside the
 * guild name ("Reisleider — trip planner"), what they start with, and a way
 * to say hello. It replaced a line of prose that named people the reader
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
        {intro.members.map((member) => {
          const gezel = gezels?.get(member.gezelId);
          return (
            <li key={member.gezelId} className="msg-crew-card">
              <GezelIcon
                svg={gezel?.icon ?? null}
                poppetje={gezel?.poppetje ?? null}
                iconOverride={gezel?.iconOverride === true}
                name={member.name}
                size={44}
              />
              <div className="msg-crew-card-text">
                <span className="msg-crew-card-name">{member.name}</span>
                {member.role && (
                  <span className="msg-crew-card-role">
                    {member.role}
                    {member.gloss ? ` — ${member.gloss}` : ''}
                  </span>
                )}
                {member.stepName ? (
                  <span className="msg-crew-card-purpose">Starts with “{member.stepName}”</span>
                ) : member.purpose ? (
                  <span className="msg-crew-card-purpose">{member.purpose}</span>
                ) : null}
              </div>
              <button
                type="button"
                className="gz-key msg-crew-card-hello"
                onClick={() => navigateToTab({ kind: 'gezel', id: member.gezelId })}
              >
                Say hello
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
