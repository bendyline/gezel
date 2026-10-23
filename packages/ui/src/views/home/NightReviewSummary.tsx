export function NightReviewSummary({
  completed,
  reports,
  proposals = 0,
  actions = 0,
}: { completed: number; reports: number; proposals?: number; actions?: number }) {
  return (
    <p className="home-workshop-night-summary">
      {completed} task{completed === 1 ? '' : 's'} finished overnight, {reports} report
      {reports === 1 ? '' : 's'} written
      {proposals > 0 ? `, ${proposals} change proposal${proposals === 1 ? '' : 's'} waiting` : ''}
      {actions > 0 ? ` — ${actions} suggested action${actions === 1 ? '' : 's'} to review.` : '.'}
    </p>
  );
}
