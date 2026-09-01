import type { SessionTreeBranch } from './session-thread-nesting.js';

export function SessionTreeGuides(props: {
  branch: SessionTreeBranch;
  phase: 'divider' | 'thread';
}): React.ReactNode {
  const { branch, phase } = props;
  const ancestorLevels = branch.ancestorContinuationLevels.filter(
    (level) => level >= 2 && level <= 4,
  );
  const continuationLevels =
    phase === 'thread' && branch.hasFollowingSibling ? [1, ...ancestorLevels] : ancestorLevels;

  return (
    <>
      {continuationLevels.map((level) => (
        <span
          key={`${phase}:${level}`}
          className={`timeline-tree-guide timeline-tree-guide-${phase} timeline-tree-guide-up-${level}`}
          aria-hidden="true"
        />
      ))}
      {phase === 'divider' && (
        <>
          <span
            className={`timeline-tree-parent-line timeline-tree-guide-up-1${
              branch.hasFollowingSibling ? ' timeline-tree-parent-line-continues' : ''
            }`}
            aria-hidden="true"
          />
          <span className="timeline-tree-elbow timeline-tree-guide-up-1" aria-hidden="true" />
        </>
      )}
    </>
  );
}
