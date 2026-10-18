import { parseWorkOptionId } from '../schemas/work-options.js';

/**
 * Does this call create a project? The local providers allow one per turn:
 * a small model that emits several in one response would otherwise make
 * that many projects, voormen and kickoff tasks. A `start_work` that
 * launches a craftbook is not one — the root-turn invocation key already
 * dedupes those.
 */
export function isProjectStartingCall(name: string, args: unknown): boolean {
  if (name === 'start_project' || name === 'start_job') return true;
  if (name !== 'start_work' || !args || typeof args !== 'object') return false;
  const option = (args as { option?: unknown }).option;
  const parsed = typeof option === 'string' ? parseWorkOptionId(option) : null;
  return parsed?.kind === 'new-project' || parsed?.kind === 'project-type';
}
