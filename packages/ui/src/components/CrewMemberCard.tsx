import type { CrewMember, GezelSummary } from '@bendyline/gezel';
import { GezelIcon } from './GezelIcon.js';
import { navigateToTab } from './nav-actions.js';

/**
 * One gezel on a crew: portrait, their role in plain words, what they start
 * with, and a way to say hello. Shared by the crew introduction in a thread
 * and a request tracker's "Who's helping?".
 */
export function CrewMemberCard({ member, gezel }: { member: CrewMember; gezel?: GezelSummary }) {
  return (
    <li className="msg-crew-card">
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
}
