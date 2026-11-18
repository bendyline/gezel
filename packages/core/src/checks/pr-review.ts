/**
 * The pull-request review's shared rules: how a patch record numbers its
 * lines, what a numbered finding may say, how a reviewer's cross-file
 * questions are validated, and which changed files are generated.
 *
 * One owner because three readers must agree: the connector that writes the
 * records, the gate that judges a reviewer's observations, and the stdlib
 * script that indexes them for the final report. They did not (2026-11-17,
 * a 57-file pull request on a 27B local model): the gate rejected one correct
 * finding three times for the phrase "If `vsce` fails" while its message
 * blamed the line number, the reviewer spent its turns counting diff lines by
 * hand to produce that number, and a second copy of the same pattern in the
 * summary script would have dropped the finding from the report had it ever
 * passed. One batch of fifteen finished in 96 minutes.
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Shown above a numbered patch, and what marks a record as numbered: a reader
 * that finds this sentence strips the number column before reading the diff.
 * It describes and never instructs, because a record is content from outside;
 * how to cite a line is the step prompt's to say.
 */
export const PATCH_LINE_LEGEND =
  'Each patch line starts with its line number in the new file, then the diff marker (`+` added, `-` removed, space unchanged). A removed line has no number.';

export interface PatchLine {
  kind: 'add' | 'remove' | 'context';
  /** Line number in the new file. A removed line has none. */
  newLine?: number;
  /** The line's own text, without its diff marker. */
  text: string;
}

export interface ParsedPatchRecord {
  lines: PatchLine[];
  /** Every new-file line number the patch shows, added or unchanged. */
  newLines: Set<number>;
}

interface PatchSlot {
  kind: PatchLine['kind'] | 'meta';
  newLine?: number;
  raw: string;
}

/**
 * The width comes from the hunk headers, never from the lines that follow
 * them, so a patch cut off mid-hunk still gets the column its reader expects.
 */
function numberColumnWidth(lines: readonly string[]): number {
  let last = 0;
  for (const line of lines) {
    const header = HUNK_HEADER_RE.exec(line);
    if (!header) continue;
    const count = header[4] === undefined ? 1 : Number(header[4]);
    if (count > 0) last = Math.max(last, Number(header[3]) + count - 1);
  }
  return last > 0 ? String(last).length : 0;
}

function walkPatch(lines: readonly string[], numberedWidth: number): Array<PatchSlot | null> {
  const slots: Array<PatchSlot | null> = [];
  let oldLeft = 0;
  let newLeft = 0;
  let next = 0;
  let inHunk = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const header = HUNK_HEADER_RE.exec(line);
    if (header) {
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      next = Number(header[3]);
      inHunk = true;
      slots.push(null);
      continue;
    }
    if (!inHunk || (index === lines.length - 1 && line === '')) {
      slots.push(null);
      continue;
    }
    const raw = numberedWidth > 0 ? line.slice(numberedWidth + 1) : line;
    if (raw.startsWith('\\')) {
      slots.push({ kind: 'meta', raw });
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      inHunk = false;
      slots.push(null);
      continue;
    }
    if (raw.startsWith('+')) {
      slots.push({ kind: 'add', newLine: next, raw });
      next += 1;
      newLeft -= 1;
    } else if (raw.startsWith('-')) {
      slots.push({ kind: 'remove', raw });
      oldLeft -= 1;
    } else {
      slots.push({ kind: 'context', newLine: next, raw });
      next += 1;
      newLeft -= 1;
      oldLeft -= 1;
    }
  }
  return slots;
}

/**
 * Put each line's new-file number in front of it. A reviewer cites
 * `path:line`, and a raw unified diff states that number only once per hunk:
 * left to derive the rest, a model lists the hunk line by line and counts.
 */
export function numberUnifiedPatch(patch: string): string {
  const lines = patch.split('\n');
  const width = numberColumnWidth(lines);
  if (width === 0) return patch;
  const blank = ' '.repeat(width);
  const slots = walkPatch(lines, 0);
  return lines
    .map((line, index) => {
      const slot = slots[index];
      if (!slot) return line;
      const column = slot.newLine === undefined ? blank : String(slot.newLine).padStart(width);
      return `${column} ${line}`;
    })
    .join('\n');
}

/**
 * Read the patch out of a changed-file record, numbered or not. A record
 * written before patches were numbered still yields its line numbers, worked
 * out from the hunk headers. Null when the record carries no patch.
 */
export function parsePatchRecord(record: string): ParsedPatchRecord | null {
  const all = record.split(/\r?\n/);
  const open = all.indexOf('```diff');
  if (open < 0) return null;
  const close = all.lastIndexOf('```');
  const body = all.slice(open + 1, close > open ? close : all.length);
  const width = record.includes(PATCH_LINE_LEGEND) ? numberColumnWidth(body) : 0;
  const lines: PatchLine[] = [];
  const newLines = new Set<number>();
  for (const slot of walkPatch(body, width)) {
    if (!slot || slot.kind === 'meta') continue;
    lines.push({
      kind: slot.kind,
      ...(slot.newLine !== undefined ? { newLine: slot.newLine } : {}),
      text: slot.raw.slice(1),
    });
    if (slot.newLine !== undefined) newLines.add(slot.newLine);
  }
  return { lines, newLines };
}

/** `6-12, 19-36, 83` — the lines a patch shows, short enough to put in a message. */
export function formatLineRanges(lines: ReadonlySet<number>, limit = 8): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  const close = () => {
    if (start === undefined || previous === undefined) return;
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  };
  for (const line of sorted.slice(1)) {
    if (previous !== undefined && line === previous + 1) {
      previous = line;
      continue;
    }
    close();
    start = line;
    previous = line;
  }
  close();
  return ranges.length > limit
    ? `${ranges.slice(0, limit).join(', ')} and ${ranges.length - limit} more range(s)`
    : ranges.join(', ');
}

export interface PrFindingBlock {
  batch: number;
  id: string;
  text: string;
}

/**
 * Models write a numbered finding plain, bold, as a heading, a bullet, or a
 * table row. Matching only `B1-1:` let `**B1-1** ...` and `B1-1 | ...` pass
 * every check unread.
 */
export const PR_FINDING_START_RE = /^\s*(?:#{1,6}\s+|[-*]\s+)?(?:\*\*)?B(\d+)-(\d+)(?:\*\*)?\b/i;

export function prFindingBlocks(text: string): PrFindingBlock[] {
  const lines = text.split(/\r?\n/);
  const starts: Array<{ index: number; batch: number; id: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    const match = PR_FINDING_START_RE.exec(lines[index]!);
    if (!match) continue;
    starts.push({ index, batch: Number(match[1]), id: `B${match[1]}-${match[2]}` });
  }
  return starts.map((start, position) => {
    const next = starts[position + 1]?.index ?? lines.length;
    let end = next;
    for (let index = start.index + 1; index < next; index++) {
      if (/^\s*#{1,4}\s+/.test(lines[index]!)) {
        end = index;
        break;
      }
    }
    return { batch: start.batch, id: start.id, text: lines.slice(start.index, end).join('\n') };
  });
}

const NOT_A_DEFECT_RE =
  /\b(?:verified\s+ok|no\s+(?:defect|issue|finding|action\s+needed|functional\s+issue)|not\s+(?:a\s+bug|a\s+(?:functional|correctness)\s+defect|a\s+defect|introduced\s+by\s+this\s+patch|available\s+(?:in|for)\s+this\s+batch)|none\s+needed|acceptable(?:\s+as[- ]is)?|accept\s+as[- ]is|worth\s+noting|future\s+(?:optimization|hardening)|pre[- ]existing|functionally\s+harmless|intentional\s+limitation|needs?\s+(?:(?:central|cross[- ]file)\s+)?verification|requires?\s+(?:central\s+)?verification|central\s+verification|not\s+audited|implementation\s+(?:is\s+)?unknown|no\s+evidence\s+(?:of|that).{0,80}\bavailable|correct\s+(?:and\s+bounded\s+)?fallback|intent\s+is\s+correct|best[- ]effort|harmless\s+here|does\s+not\s+affect\s+runtime\s+behavior|(?:this\s+)?finding\s+is\s+contingent|risk\s+(?:is\s+)?low|(?:style|quoting|backslash)\s+(?:inconsistency|concern)|standardiz(?:e|ing)|verify\s+whether)\b/is;

const HEDGE_RE = /\b(?:may|might|could|possibly|potential(?:ly)?|likely)\b/i;

export interface PrFindingWordingProblem {
  /** `not-a-defect`: the finding says so itself. `hedge`: it is unsure of its own mechanism. */
  kind: 'not-a-defect' | 'hedge';
  /** The exact words matched, so a rejection can quote them. */
  phrase: string;
}

/**
 * What a numbered finding says that a proved defect would not. Read from the
 * prose only: a quoted comment or a shell snippet holds words like "may" and
 * "if this fails" that are the code's, not the reviewer's.
 *
 * Deliberately absent: a conditional ("if the publish fails, the step still
 * exits 0" is how an error-handling defect is stated), and the topic words
 * `comment`, `documentation` and `verify`, which a finding about a doc file or
 * a missing signature check cannot avoid.
 */
export function prFindingWordingProblem(text: string): PrFindingWordingProblem | null {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const notDefect = NOT_A_DEFECT_RE.exec(prose);
  if (notDefect) {
    return { kind: 'not-a-defect', phrase: notDefect[0].replace(/\s+/g, ' ') };
  }
  const hedge = HEDGE_RE.exec(prose);
  return hedge ? { kind: 'hedge', phrase: hedge[0] } : null;
}

export interface PrVerificationCandidate {
  id: string;
  path: string;
  line: number;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  claim: string;
  verify: string;
}

/** The length a reviewer is asked to keep a claim or a verification target under. */
export const PR_CANDIDATE_TEXT_LIMIT = 400;
/**
 * The length that is refused. Wider than the one asked for because a model
 * cannot count its own characters: claims of 409 and 412 against a stated
 * "concise" cost one batch two rejected passes.
 */
const PR_CANDIDATE_TEXT_REFUSED_OVER = 600;
const PR_CANDIDATE_KEYS = ['id', 'path', 'line', 'severity', 'claim', 'verify'];
const PR_SEVERITIES = ['critical', 'major', 'minor', 'nit'];

/**
 * Pull a batch's cross-file questions out of their Markdown wrapper. A
 * B-number is a defect the batch can already prove; a V-number is a bounded
 * question the checkout-aware final reviewer still has to resolve. Every
 * problem names the entry and the field, with the value that was wrong.
 */
export function parsePrVerificationCandidates(
  text: string,
  batch: number,
  assignedPaths: readonly string[],
): { candidates: PrVerificationCandidate[]; problems: string[] } {
  const none = (problem: string) => ({ candidates: [], problems: [problem] });
  const heading = /^#{1,6}\s+Verification candidates\s*$/im.exec(text);
  if (!heading) {
    return none(
      'add a "Verification candidates" heading with one JSON block containing {"verificationCandidates":[]}',
    );
  }
  const afterHeading = text.slice(heading.index + heading[0].length);
  const nextHeadingOffset = afterHeading.search(/^#{1,6}\s+/m);
  const section = nextHeadingOffset >= 0 ? afterHeading.slice(0, nextHeadingOffset) : afterHeading;
  const blocks = [...section.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const json = blocks[0]?.[1];
  if (blocks.length !== 1 || json === undefined) {
    return none(
      'the "Verification candidates" section must contain exactly one fenced JSON block with a verificationCandidates array',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return none(
      `verificationCandidates JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return none('verificationCandidates JSON must be an object');
  }
  const topLevelKeys = Object.keys(value);
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== 'verificationCandidates') {
    return none('verificationCandidates JSON must contain only the verificationCandidates key');
  }
  const raw = (value as Record<string, unknown>).verificationCandidates;
  if (!Array.isArray(raw)) return none('verificationCandidates must be an array');
  if (raw.length > 12) return none('verificationCandidates must contain at most 12 entries');

  const candidates: PrVerificationCandidate[] = [];
  const problems: string[] = [];
  for (let index = 0; index < raw.length; index++) {
    const candidate = raw[index];
    const expectedId = `V${batch}-${index + 1}`;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      problems.push(`verificationCandidates[${index}] must be an object`);
      continue;
    }
    const fields = candidate as Record<string, unknown>;
    const found: string[] = [];
    if (fields.id !== expectedId) {
      found.push(
        `id is ${JSON.stringify(fields.id)}; entry ${index + 1} must be "${expectedId}" (number them in order)`,
      );
    }
    if (typeof fields.path !== 'string' || !assignedPaths.includes(fields.path)) {
      found.push(`path ${JSON.stringify(fields.path)} is not one of this batch's changed paths`);
    }
    if (!Number.isSafeInteger(fields.line) || Number(fields.line) < 1) {
      found.push(`line must be a whole number above 0, not ${JSON.stringify(fields.line)}`);
    }
    if (!PR_SEVERITIES.includes(String(fields.severity))) {
      found.push(
        `severity ${JSON.stringify(fields.severity)} must be critical, major, minor, or nit`,
      );
    }
    for (const [key, least, what] of [
      ['claim', 10, 'one sentence stating the failure'],
      ['verify', 3, 'the file, symbol, or route to inspect'],
    ] as const) {
      const body = fields[key];
      if (typeof body !== 'string' || body.trim().length < least) {
        found.push(`${key} must be ${what}`);
      } else if (body.length > PR_CANDIDATE_TEXT_REFUSED_OVER) {
        found.push(
          `${key} is ${body.length} characters; cut it to ${PR_CANDIDATE_TEXT_LIMIT} or fewer`,
        );
      }
    }
    const extra = Object.keys(fields).filter((key) => !PR_CANDIDATE_KEYS.includes(key));
    if (extra.length > 0) {
      found.push(`has extra key(s) ${extra.join(', ')}; keep only ${PR_CANDIDATE_KEYS.join(', ')}`);
    }
    if (found.length > 0) {
      problems.push(`${expectedId}: ${found.join('; ')}`);
      continue;
    }
    candidates.push({
      id: expectedId,
      path: fields.path as string,
      line: fields.line as number,
      severity: fields.severity as PrVerificationCandidate['severity'],
      claim: (fields.claim as string).trim(),
      verify: (fields.verify as string).trim(),
    });
  }
  return { candidates, problems };
}

export type GeneratedFileKind = 'lockfile' | 'third-party-notices';

const LOCKFILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'deno.lock',
  'flake.lock',
  'gemfile.lock',
  'go.sum',
  'gradle.lockfile',
  'mix.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'package.resolved',
  'packages.lock.json',
  'pdm.lock',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'podfile.lock',
  'poetry.lock',
  'pubspec.lock',
  'uv.lock',
  'yarn.lock',
]);

const THIRD_PARTY_NOTICES_RE = /^third[-_ ]?party[-_ ]?(?:notices?|licen[cs]es?)(?:\.[a-z0-9]+)?$/i;

/**
 * A changed file a tool wrote and a person does not read line by line. Kept
 * narrow on purpose: these get a summary instead of a reviewer, so a file
 * wrongly named here goes unread. On the pull request that prompted this, one
 * lockfile and seven notices files were 49% of the patch text.
 */
export function generatedFileKind(path: string): GeneratedFileKind | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (LOCKFILE_NAMES.has(name.toLowerCase())) return 'lockfile';
  if (THIRD_PARTY_NOTICES_RE.test(name)) return 'third-party-notices';
  return null;
}

const GENERATED_KIND_LABEL: Record<GeneratedFileKind, string> = {
  lockfile: 'Dependency lockfile',
  'third-party-notices': 'Third-party notices',
};

const TARBALL_URL_RE =
  /https?:\/\/([^/\s"']+)\/(?:[^\s"']*?\/)??((?:@[^/\s"']+\/)?[^/\s"'@]+)\/-\/([^/\s"'#]+)\.tgz/;
const PUBLIC_REGISTRY_HOSTS = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);
/**
 * Generous because nothing else carries this list forward: at 30, a real
 * lockfile's 110 changes showed the scoped packages and cut off before the
 * unscoped one a reviewer had asked about.
 */
const PACKAGE_CHANGE_LIMIT = 200;

interface LockfileChanges {
  changes: string[];
  /** Hosts other than the public registry, with the first line that names each. */
  otherHosts: Array<{ host: string; line: number; packages: number }>;
}

/**
 * Read package changes off the tarball URLs a lockfile patch adds and
 * removes. The URL carries name and version on one line, so this needs no
 * knowledge of where a hunk cut the surrounding entry.
 */
function lockfileChanges(patch: ParsedPatchRecord): LockfileChanges {
  const added = new Map<string, Set<string>>();
  const removed = new Map<string, Set<string>>();
  const hosts = new Map<string, { line: number; packages: number }>();
  for (const line of patch.lines) {
    if (line.kind === 'context') continue;
    const match = TARBALL_URL_RE.exec(line.text);
    if (!match) continue;
    const host = match[1]!;
    const name = match[2]!;
    const base = `${name.slice(name.lastIndexOf('/') + 1)}-`;
    if (!match[3]!.startsWith(base)) continue;
    const version = match[3]!.slice(base.length);
    const side = line.kind === 'add' ? added : removed;
    side.set(name, (side.get(name) ?? new Set()).add(version));
    if (line.kind === 'add' && !PUBLIC_REGISTRY_HOSTS.has(host) && line.newLine !== undefined) {
      const seen = hosts.get(host);
      if (seen) seen.packages += 1;
      else hosts.set(host, { line: line.newLine, packages: 1 });
    }
  }
  const changes: string[] = [];
  for (const name of [...new Set([...added.keys(), ...removed.keys()])].sort()) {
    const now = [...(added.get(name) ?? [])].filter((v) => !removed.get(name)?.has(v)).sort();
    const before = [...(removed.get(name) ?? [])].filter((v) => !added.get(name)?.has(v)).sort();
    if (now.length > 0 && before.length > 0) {
      changes.push(`${name} ${before.join(', ')} to ${now.join(', ')}`);
    } else if (now.length > 0) {
      changes.push(`${name} ${now.join(', ')} added`);
    } else if (before.length > 0) {
      changes.push(`${name} ${before.join(', ')} removed`);
    }
  }
  return {
    changes,
    otherHosts: [...hosts].map(([host, seen]) => ({ host, ...seen })),
  };
}

export interface GeneratedBatchFile {
  path: string;
  kind: GeneratedFileKind;
  /** The file's record text; null when it could not be read. */
  record: string | null;
}

/**
 * The observations file for a batch of generated files, written by the
 * runtime in the shape a reviewer's batch has, so coverage and synthesis
 * treat it like any other. A lockfile that resolves a package from somewhere
 * other than the public registry becomes a question for the final reviewer:
 * that is the one thing in these files a read by a model was looking for.
 */
export function generatedBatchObservations(batch: {
  batchNumber: number;
  start: number;
  end: number;
  files: readonly GeneratedBatchFile[];
}): string {
  const out = [
    `# Batch ${batch.batchNumber} — files ${batch.start}–${batch.end}`,
    '',
    'Generated files. The runtime summarized these from their patches; no reviewer read them line by line.',
  ];
  const candidates: PrVerificationCandidate[] = [];
  for (const file of batch.files) {
    out.push('', `## ${file.path}`, '');
    const patch = file.record === null ? null : parsePatchRecord(file.record);
    const label = GENERATED_KIND_LABEL[file.kind];
    if (!patch) {
      out.push(`${label}. No patch available.`);
      continue;
    }
    const addedLines = patch.lines.filter((line) => line.kind === 'add').length;
    const removedLines = patch.lines.filter((line) => line.kind === 'remove').length;
    out.push(`${label}: +${addedLines} / -${removedLines} lines.`);
    if (file.kind !== 'lockfile') continue;
    const { changes, otherHosts } = lockfileChanges(patch);
    if (changes.length > 0) {
      out.push('', ...changes.slice(0, PACKAGE_CHANGE_LIMIT).map((change) => `- ${change}`));
      if (changes.length > PACKAGE_CHANGE_LIMIT) {
        out.push(`- and ${changes.length - PACKAGE_CHANGE_LIMIT} more package change(s)`);
      }
    }
    for (const other of otherHosts.slice(0, 3)) {
      candidates.push({
        id: `V${batch.batchNumber}-${candidates.length + 1}`,
        path: file.path,
        line: other.line,
        severity: 'minor',
        claim: `The lockfile resolves ${other.packages} package(s) from ${other.host}, not the public npm registry.`,
        verify: `Confirm ${other.host} is a registry this repository intends to install from (.npmrc, publishConfig, or the package manager settings).`,
      });
    }
  }
  out.push(
    '',
    '## Verification candidates',
    '',
    '```json',
    JSON.stringify({ verificationCandidates: candidates }, null, 2),
    '```',
    '',
  );
  return out.join('\n');
}
