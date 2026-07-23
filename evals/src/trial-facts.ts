import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { score } from './bin/score-trial.ts';

/**
 * Rebuild the observable-facts snapshot from the authoritative artifacts in
 * a trial directory. Finalization calls this after result.json is written;
 * optional post-processors (such as the advisory LLM judge) call it again
 * after adding their own sibling artifacts so facts.json cannot go stale.
 */
export async function writeTrialFacts(runDir: string): Promise<void> {
  const facts = score(runDir);
  await writeFile(join(runDir, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
}
