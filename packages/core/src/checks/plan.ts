/**
 * Structural plan validation (`kind: 'planStructure'`) — the Planner
 * role's mechanical floor. Validates the FIRST Markdown table in the
 * text against the plan contract: `ID | Task | Owner | Depends on |
 * Done when` (+ optional `Estimate`), owners on-roster, dependencies
 * that resolve, contain no cycles, and (by default) point only at
 * EARLIER rows, and done-states long enough to be checkable.
 *
 * Law-3 details: every failure names the offending row and cell
 * verbatim so the rejection is the fix instruction.
 */

import { parseMarkdownTable } from './records.js';

export interface PlanStructureSpec {
  minRows?: number;
  /** When given, every Owner must be one of these names (case-insensitive). */
  ownerRoster?: readonly string[];
  /** Rows may only depend on earlier rows (default true). */
  requireEarlierOnly?: boolean;
  /** Minimum Done-when cell length (default 12 chars). */
  doneWhenMinChars?: number;
}

export interface PlanRow {
  id: string;
  task: string;
  owner: string;
  dependsOn: string[];
  doneWhen: string;
  estimate?: string;
}

export interface PlanStructureResult {
  ok: boolean;
  /** First failure, row+cell named (empty when ok). */
  detail: string;
  rows: PlanRow[];
  unknownDeps: string[];
  cycleIds: string[];
  missingOwners: string[];
  weakDoneStates: string[];
}

const REQUIRED_COLUMNS = ['id', 'task', 'owner', 'depends on', 'done when'] as const;

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((h) => h.trim().toLowerCase() === name);
}

function parseDeps(cell: string): string[] {
  const trimmed = cell.trim();
  // A single dash is the conventional table marker for “no dependency”.
  // Accept the Unicode dash characters produced by word processors and
  // models as well as ASCII hyphen-minus; none of them can be a row ID by
  // themselves.
  if (!trimmed || /^[-\u2010-\u2015\u2212]$/.test(trimmed) || /^(none|n\/a)$/i.test(trimmed)) {
    return [];
  }
  return trimmed
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function planStructure(text: string, spec: PlanStructureSpec = {}): PlanStructureResult {
  const fail = (
    detail: string,
    partial: Partial<PlanStructureResult> = {},
  ): PlanStructureResult => ({
    ok: false,
    detail,
    rows: [],
    unknownDeps: [],
    cycleIds: [],
    missingOwners: [],
    weakDoneStates: [],
    ...partial,
  });

  const table = parseMarkdownTable(text);
  if (!table) {
    return fail(
      'no Markdown table found — the plan needs a table with columns ID | Task | Owner | Depends on | Done when',
    );
  }
  const headers = table.headers.map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => headerIndex(headers, c) < 0);
  if (missing.length > 0) {
    return fail(
      `the plan table is missing column(s): ${missing.join(', ')} (found: ${headers.join(' | ')})`,
    );
  }
  const col = {
    id: headerIndex(headers, 'id'),
    task: headerIndex(headers, 'task'),
    owner: headerIndex(headers, 'owner'),
    deps: headerIndex(headers, 'depends on'),
    done: headerIndex(headers, 'done when'),
    estimate: headerIndex(headers, 'estimate'),
  };

  const rows: PlanRow[] = table.rows.map((cells) => ({
    id: (cells[col.id] ?? '').trim(),
    task: (cells[col.task] ?? '').trim(),
    owner: (cells[col.owner] ?? '').trim(),
    dependsOn: parseDeps(cells[col.deps] ?? ''),
    doneWhen: (cells[col.done] ?? '').trim(),
    ...(col.estimate >= 0 && (cells[col.estimate] ?? '').trim()
      ? { estimate: (cells[col.estimate] ?? '').trim() }
      : {}),
  }));

  const minRows = spec.minRows ?? 1;
  if (rows.length < minRows) {
    return fail(`the plan table has ${rows.length} row(s) — at least ${minRows} required`, {
      rows,
    });
  }

  const ids = rows.map((r) => r.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
    return fail(`duplicate plan row id "${dupe}" — every ID must be unique`, { rows });
  }
  for (const row of rows) {
    if (!row.id) return fail('a plan row has an empty ID cell', { rows });
  }

  // Owners.
  const roster = spec.ownerRoster?.map((o) => o.trim().toLowerCase());
  const missingOwners: string[] = [];
  for (const row of rows) {
    if (!row.owner) {
      missingOwners.push(row.id);
      continue;
    }
    if (roster && !roster.includes(row.owner.toLowerCase())) {
      return fail(
        `row ${row.id}: Owner "${row.owner}" is not on the roster (${(spec.ownerRoster ?? []).join(', ')})`,
        { rows, missingOwners },
      );
    }
  }
  if (missingOwners.length > 0) {
    return fail(`row ${missingOwners[0]}: the Owner cell is empty — every task needs an owner`, {
      rows,
      missingOwners,
    });
  }

  // Dependencies: resolve, earlier-only, acyclic.
  const indexOfId = new Map(rows.map((r, i) => [r.id, i]));
  const unknownDeps: string[] = [];
  for (const row of rows) {
    for (const dep of row.dependsOn) {
      if (!idSet.has(dep)) {
        unknownDeps.push(`${row.id}→${dep}`);
        return fail(
          `row ${row.id}: "Depends on" references ${dep}, which is not a row ID in this plan`,
          { rows, unknownDeps },
        );
      }
      if (dep === row.id) {
        return fail(`row ${row.id} depends on itself`, { rows });
      }
      if ((spec.requireEarlierOnly ?? true) && indexOfId.get(dep)! > indexOfId.get(row.id)!) {
        return fail(
          `row ${row.id}: "Depends on" references ${dep}, which is a LATER row — order the plan so dependencies come first`,
          { rows },
        );
      }
    }
  }
  // Cycle detection (relevant when earlier-only is off).
  const cycleIds = findCycle(rows);
  if (cycleIds.length > 0) {
    return fail(`dependency cycle: ${cycleIds.join(' → ')} — break the loop`, { rows, cycleIds });
  }

  // Done-when floors.
  const doneFloor = spec.doneWhenMinChars ?? 12;
  const weakDoneStates = rows.filter((r) => r.doneWhen.length < doneFloor).map((r) => r.id);
  if (weakDoneStates.length > 0) {
    const row = rows.find((r) => r.id === weakDoneStates[0])!;
    return fail(
      `row ${row.id}: "Done when" is "${row.doneWhen}" — too vague to check (write an observable completion state, at least ${doneFloor} characters)`,
      { rows, weakDoneStates },
    );
  }

  return {
    ok: true,
    detail: '',
    rows,
    unknownDeps: [],
    cycleIds: [],
    missingOwners: [],
    weakDoneStates: [],
  };
}

function findCycle(rows: PlanRow[]): string[] {
  const deps = new Map(rows.map((r) => [r.id, r.dependsOn]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];
  let cycle: string[] = [];
  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      cycle = [...path.slice(start), id];
      return true;
    }
    visiting.add(id);
    path.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (visit(dep)) return true;
    }
    visiting.delete(id);
    path.pop();
    done.add(id);
    return false;
  };
  for (const row of rows) {
    if (visit(row.id)) break;
  }
  return cycle;
}
