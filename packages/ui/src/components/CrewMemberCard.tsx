import { type CrewMember, type GezelSummary, plainRoleTitle } from '@bendyline/gezel';
import { GezelIcon } from './GezelIcon.js';
import { navigateToTab } from './nav-actions.js';

/**
 * One gezel on a crew: portrait, their role in plain words, what they do,
 * and a way to say hello. Shared by the crew introduction in a thread and a
 * request tracker's "Who's helping?". An introduction saved before roles
 * were plain English still carries the Dutch title (and a gloss), so the
 * role goes through `plainRoleTitle` rather than printing as stored. The
 * step they start on is the plan's word, not theirs: `Starts with "First
 * draft"` read as a schedule (2026-11-09). Until the roster names them, the
 * portrait is a quiet placeholder rather than a letter that turns into a
 * figure a moment later.
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
        {...(gezel ? {} : { pending: true })}
      />
      <div className="msg-crew-card-text">
        <span className="msg-crew-card-name">{member.name}</span>
        {member.role && <span className="msg-crew-card-role">{plainRoleTitle(member.role)}</span>}
        {member.purpose && <span className="msg-crew-card-purpose">{member.purpose}</span>}
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
