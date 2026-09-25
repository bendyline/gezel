/**
 * The declarative gate checks both hosts evaluate the same way.
 *
 * Every check calls the shared predicates in `checks/`; what was duplicated
 * was the dispatch around them, the artifact-drawer swap, and the prose a
 * failing check shows. The desktop keeps the kinds only it can run (regex,
 * executable syntax, sandboxed execution, judged evidence); a host that
 * cannot run one fails it closed rather than passing a deliverable it
 * could not examine.
 */
import {
  cssMinBytes,
  csvShape,
  explainSniff,
  fileCountByExt,
  fileMinBytes,
  jsonPathEquals,
  recordSchema,
  runSniff,
  tableShape,
  totalMinBytes,
} from '../checks/index.js';
import type { WorkspaceLike } from '../checks/types.js';
import type { GateCheck } from '../schemas/gate.js';

/**
 * A workspace view plus, optionally, the project's artifacts drawer. A check
 * flagged `artifact: true` reads the drawer; a reader without the drawer
 * accessors fails such a check as "not found", never reading the wrong tree.
 */
export type GateWorkspaceReader = WorkspaceLike & {
  readArtifact?: (file: string) => Promise<string | null>;
  listArtifacts?: () => Promise<string[]>;
  /** Artifact-tree sibling of `WorkspaceLike.readBytes` (image-signature checks). */
  readArtifactBytes?: (file: string) => Promise<Uint8Array | null>;
};

export const SHARED_GATE_CHECK_KINDS = [
  'minBytes',
  'totalMinBytes',
  'fileCount',
  'cssMinBytes',
  'sniff',
  'jsonPathEquals',
  'csvShape',
  'tableShape',
  'recordSchema',
] as const;

export type SharedGateCheck = Extract<
  GateCheck,
  { kind: (typeof SHARED_GATE_CHECK_KINDS)[number] }
>;

export function isSharedGateCheck(check: GateCheck): check is SharedGateCheck {
  return (SHARED_GATE_CHECK_KINDS as readonly string[]).includes(check.kind);
}

/** The tree a check reads: the artifacts drawer when flagged, else the workspace. */
export function readerForCheck(
  ws: GateWorkspaceReader,
  check: { artifact?: boolean },
): WorkspaceLike {
  if (check.artifact !== true) return ws;
  return {
    read: ws.readArtifact ?? (async () => null),
    list: ws.listArtifacts ?? (async () => []),
    ...(ws.readArtifactBytes ? { readBytes: ws.readArtifactBytes.bind(ws) } : {}),
  };
}

export interface DeclarativeCheckOutcome {
  ok: boolean;
  /** One line: the concrete gap on failure, a brief diagnostic on success. */
  detail: string;
  evidence?: Record<string, unknown>;
}

/** Cap for evidence arrays carried on an outcome. */
const EVIDENCE_LIST_CAP = 10;
const capList = (values: readonly string[]): string[] => values.slice(0, EVIDENCE_LIST_CAP);
function shapeEvidence(r: {
  ok: boolean;
  headers?: string[];
  rowCount?: number;
}): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (r.headers) out.headers = capList(r.headers);
  if (r.rowCount !== undefined) out.rowCount = r.rowCount;
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function evaluateDeclarativeCheck(
  c: SharedGateCheck,
  ws: GateWorkspaceReader,
): Promise<DeclarativeCheckOutcome> {
  const reader = readerForCheck(ws, c as { artifact?: boolean });
  switch (c.kind) {
    case 'minBytes': {
      const r = await fileMinBytes(reader, c.file, c.bytes);
      return { ok: r.ok, detail: r.detail };
    }
    case 'totalMinBytes': {
      const r = await totalMinBytes(reader, c.files, c.bytes);
      return { ok: r.ok, detail: r.detail };
    }
    case 'fileCount': {
      const r = await fileCountByExt(reader, c.ext, c.min, c.dir, {
        ...(c.verifyImageBytes ? { verifyImageBytes: true } : {}),
      });
      const matched = (r as { matched?: string[] }).matched;
      return {
        ok: r.ok,
        detail: r.detail,
        ...(matched ? { evidence: { matched: capList(matched) } } : {}),
      };
    }
    case 'cssMinBytes': {
      const r = await cssMinBytes(reader, c.bytes, c.file);
      return { ok: r.ok, detail: r.detail };
    }
    case 'sniff': {
      const content = await reader.read(c.file);
      if (content === null)
        return {
          ok: false,
          detail: `${c.file} not found (needed for the ${c.sniff} check)`,
          evidence: { sniff: c.sniff },
        };
      if (runSniff(c.sniff, content))
        return {
          ok: true,
          detail: `${c.file} passes the ${c.sniff} check`,
          evidence: { sniff: c.sniff },
        };
      // Name the actual gap, not the rule.
      return {
        ok: false,
        detail: `${c.file} failed the ${c.sniff} check: ${explainSniff(c.sniff, content)}`,
        evidence: { sniff: c.sniff },
      };
    }
    case 'jsonPathEquals': {
      const r = await jsonPathEquals(reader, c.file, c.path, c.value, c.label);
      const actual = (r as { actual?: unknown }).actual;
      return {
        ok: r.ok,
        detail: r.detail,
        ...(actual !== undefined ? { evidence: { actual } } : {}),
      };
    }
    case 'csvShape': {
      const content = await reader.read(c.file);
      const r = csvShape(content, {
        ...(c.requiredColumns ? { requiredColumns: c.requiredColumns } : {}),
        ...(c.exactColumns ? { exactColumns: c.exactColumns } : {}),
        ...(c.minRows !== undefined ? { minRows: c.minRows } : {}),
        ...(c.consistentColumns !== undefined ? { consistentColumns: c.consistentColumns } : {}),
        ...(c.allowedValues ? { allowedValues: c.allowedValues } : {}),
      });
      return {
        ok: r.ok,
        detail: r.ok ? r.detail : `${c.file}: ${r.detail}`,
        evidence: shapeEvidence(r),
      };
    }
    case 'tableShape': {
      const content = await reader.read(c.file);
      if (content === null)
        return { ok: false, detail: `${c.file} not found (needed for the table-shape check)` };
      const r = tableShape(content, {
        ...(c.requiredColumns ? { requiredColumns: c.requiredColumns } : {}),
        ...(c.minRows !== undefined ? { minRows: c.minRows } : {}),
      });
      return {
        ok: r.ok,
        detail: r.ok ? r.detail : `${c.file}: ${r.detail}`,
        evidence: shapeEvidence(r),
      };
    }
    case 'recordSchema': {
      const content = await reader.read(c.file);
      const r = recordSchema(content, {
        fields: c.fields,
        ...(c.minRows !== undefined ? { minRows: c.minRows } : {}),
        ...(c.uniqueBy ? { uniqueBy: c.uniqueBy } : {}),
        ...(c.format ? { format: c.format } : {}),
        ...(c.allowExtraFields !== undefined ? { allowExtraFields: c.allowExtraFields } : {}),
      });
      const rowCount = (r as { rowCount?: number }).rowCount;
      return {
        ok: r.ok,
        detail: r.ok ? r.detail : `${c.file}: ${r.detail}`,
        ...(rowCount !== undefined ? { evidence: { rowCount } } : {}),
      };
    }
  }
}

/**
 * Stable identity of a configured check: kind + file + the configuration
 * discriminator, never an observed value, so it hashes the same across
 * attempts. Covers every kind, including the desktop-only ones.
 */
export function gateCheckLabel(c: GateCheck): string {
  switch (c.kind) {
    case 'minBytes':
      return `minBytes ${c.file}`;
    case 'totalMinBytes':
      return `totalMinBytes ${c.files.join('+')}`;
    case 'fileCount':
      return `fileCount ${c.ext.join(',')}${c.dir ? ` ${c.dir}` : ''}`;
    case 'cssMinBytes':
      return `cssMinBytes ${c.file ?? 'index.html'}`;
    case 'sniff':
      return `sniff ${c.file} ${c.sniff}`;
    case 'jsonPathEquals':
      return `jsonPathEquals ${c.file} ${c.path}`;
    case 'csvShape':
      return `csvShape ${c.file}`;
    case 'contains':
      return `contains ${c.file} /${c.pattern}/`;
    case 'notContains':
      return `notContains ${c.file} /${c.pattern}/`;
    case 'unsupportedClaims':
      return `unsupportedClaims ${c.file}`;
    case 'jsParses':
      return `jsParses ${c.file ?? 'index.html'}`;
    case 'htmlLint':
      return `htmlLint ${c.file}`;
    case 'esmImports':
      return `esmImports ${c.file}`;
    case 'sourceParses':
      return `sourceParses ${c.file}`;
    case 'tableShape':
      return `tableShape ${c.file}`;
    case 'recordSchema':
      return `recordSchema ${c.file}`;
    case 'nodeRuns':
      return `nodeRuns ${c.file}`;
    case 'citationsResolve':
      return `citationsResolve ${c.file}`;
    case 'researchEvidence':
      return `researchEvidence ${c.sourcePath?.trim() || c.tools.join(',')}`;
    case 'imageEvidence':
      return `imageEvidence ${c.file} ${c.imagesKey}`;
    case 'commandEvidence':
      return `commandEvidence ${c.script?.trim() || c.bin?.trim() || '?'} expect=${c.expect}${c.label ? ` ${c.label}` : ''}`;
    case 'corpusCoverage':
      return `corpusCoverage ${c.file} ${c.corpusDir}`;
    case 'artifactReadEvidence':
      return `artifactReadEvidence ${c.paths}`;
    case 'corpusReadEvidence':
      return `corpusReadEvidence ${c.batchesFile} batch=${c.batchNumber}`;
    case 'corpusBatchObservations':
      return `corpusBatchObservations ${c.file} batch=${c.batchNumber}`;
    case 'corpusBatches':
      return `corpusBatches ${c.file} ${c.corpusDir}`;
    case 'markdownHeadingsMatch':
      return `markdownHeadingsMatch ${c.file} ${c.outlineFile}`;
    case 'valueGrounding':
      return `valueGrounding ${c.file}`;
    case 'valuesSubsetOf':
      return `valuesSubsetOf ${c.file}`;
    case 'judge':
      return `judge ${c.file}${c.label ? ` ${c.label}` : ''}`;
    case 'planStructure':
      return `planStructure ${c.file}`;
  }
}
