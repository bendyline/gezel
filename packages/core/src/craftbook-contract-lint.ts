import type { CraftbookContract } from './schemas/craftbook-contract.js';
import type { GateCheck } from './schemas/gate.js';

/**
 * Authoring rules a schema cannot express. A contract judges the RESULT, so
 * its checks may read only what it declares: its deliverables, their text
 * sources, its inputs and its grounding sources. A check on `outline.md` or
 * `verdict.md` would quietly grade the recipe's process and fail any
 * strategy that skips it, which is the bias the contract exists to remove.
 */
export function contractLintProblems(contract: CraftbookContract): string[] {
  const declared = new Set<string>();
  const add = (path: string | undefined) => {
    if (path) declared.add(normalize(path));
  };
  for (const d of contract.deliverables) {
    add(d.path);
    add(d.textSource?.path);
  }
  for (const i of contract.inputs ?? []) add(i.path);
  for (const s of contract.grounding?.sources ?? []) add(s);

  const problems: string[] = [];
  for (const criterion of contract.criteria) {
    for (const check of criterion.checks ?? []) {
      for (const file of checkedFiles(check)) {
        if (!declared.has(normalize(file)) && ![...declared].some((d) => isUnder(file, d))) {
          problems.push(
            `criterion "${criterion.id}" checks ${file}, which the contract does not declare as a deliverable, text source, input or grounding source`,
          );
        }
      }
    }
  }
  return problems;
}

function normalize(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

function isUnder(file: string, dir: string): boolean {
  return normalize(file).startsWith(`${dir}/`);
}

/** The files a check reads, where the check names them directly. */
export function checkedFiles(check: GateCheck): string[] {
  const c = check as Record<string, unknown>;
  const files: string[] = [];
  if (typeof c.file === 'string') files.push(c.file);
  if (Array.isArray(c.files)) {
    for (const f of c.files) if (typeof f === 'string') files.push(f);
  }
  return files;
}
