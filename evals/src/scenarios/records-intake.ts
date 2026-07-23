import { csvShape, recordSchema } from '@bendyline/gezel/checks';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { findWorkspaceDeliverableNearMiss } from './helpers.ts';

/**
 * Records-intake (D2 class 6, forms-and-records) — data-entry
 * precision OFF code: consolidate messy multi-source registrations
 * (free-text emails, phone notes with mixed date formats, a stale
 * legacy CSV with duplicates) into one declared record schema at
 * `records/attendees.csv`.
 *
 * Axis: transformation precision into a declared shape. data-wrangle
 * covers the code-adjacent ETL case; this is the same discipline for
 * office-shaped records work (the Boekwachter's daily bread), with the
 * traps that actually bite: date-format normalization, dedupe-keep-
 * newest, and quoted commas in names.
 *
 * Grader notes: `checkAttendeesCsv` is pure (csv text in, sniff out),
 * built entirely from productized checks (`csvShape` + `recordSchema`)
 * plus three golden-row assertions in the data-wrangle style — the
 * expected-vs-got diffs ride the repair directive verbatim.
 */

const PROJECT_NAME = 'Conference Registration Intake';
const CLERK_NAME = 'Griet';
export const ATTENDEES_PATH = 'records/attendees.csv';

export const EXPECTED_COLUMNS = [
  'id',
  'full_name',
  'email',
  'company',
  'ticket_type',
  'registered_date',
];

// ─────────────────────────────────────────────────────────────────────
// Seeded corpus.

export const RECORDS_SEED_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'inbox/registration-emails.txt',
    content: [
      '--- email 1 ---',
      'Hi, please register me for the conference. Mara Lindqvist, mara@nordfjell.example,',
      'Nordfjell Analytics, standard ticket. Sent June 12, 2026.',
      '--- email 2 ---',
      'Two of us from Bramble & Cole: Otis Bramble (otis@bramble.example) wants the VIP',
      'ticket, and June Cole (june@bramble.example) a standard one. Registered 2026-06-13.',
      '--- email 3 ---',
      "I'd like a student ticket please — Priya Raman, priya@uni-atrium.example,",
      'Atrium University. Date: 13 June 2026.',
      '--- email 4 ---',
      'Registering for VIP: Hendrik Vos, hendrik@vos-logistics.example, Vos Logistics,',
      'on 2026-06-14.',
      '--- email 5 ---',
      'Standard ticket for Ana Sousa <ana@maretide.example> of Maretide Labs, June 14 2026.',
      '--- email 6 ---',
      'Please add my colleague: standard ticket, name Tomas Eriksen,',
      'tomas@nordfjell.example, Nordfjell Analytics, 2026-06-15.',
      '--- email 7 ---',
      'VIP registration — Freya Dunlop, freya@copperline.example, Copperline Studio,',
      'June 15, 2026.',
    ].join('\n'),
  },
  {
    path: 'notes/phone-intake.md',
    content: [
      '# Phone registrations (mixed formats — normalize dates to YYYY-MM-DD)',
      '',
      '- 16/06/2026 — "Kettle, Rosa" — rosa@kettleworks.example — Kettleworks — student',
      '- June 16, 2026 — Ibrahim Sall — ibrahim@sahelsoft.example — SahelSoft — standard',
      '- 2026-06-17 — Wen Zhao — wen@lumenring.example — Lumenring — vip',
      '- 17 Jun 2026 — Dara Quinn — dara@quinnmaps.example — Quinn Maps — standard',
    ].join('\n'),
  },
  {
    path: 'legacy/badge-list.csv',
    content: [
      'Full Name;Email;Org;Type;When',
      'Mara Lindqvist;mara@nordfjell.example;Nordfjell Analytics;standard;2026-06-01',
      'Sam Okafor;sam@brightquay.example;Brightquay;standard;2026-06-02',
      'Otis Bramble;otis@bramble.example;Bramble & Cole;standard;2026-06-03',
      'Leena Hart;leena@hartwood.example;Hartwood & Frame;vip;2026-06-04',
      'Noor Haddad;noor@atlaspress.example;Atlas Press;student;2026-06-05',
    ].join('\n'),
  },
  {
    path: 'schema.md',
    content: [
      '# Declared record schema — records/attendees.csv',
      '',
      'Comma-separated, one header row, columns EXACTLY:',
      'id,full_name,email,company,ticket_type,registered_date',
      '',
      '- id: A1, A2, A3, … in row order.',
      '- email: unique — when the same person appears in multiple sources, keep the',
      '  NEWEST registration (latest registered_date) only.',
      '- ticket_type: one of standard | vip | student (lowercase).',
      '- registered_date: ISO format YYYY-MM-DD.',
      '- Names containing commas must be quoted per CSV rules.',
    ].join('\n'),
  },
];

// ─────────────────────────────────────────────────────────────────────
// Golden rows — the traps, one assertion each (data-wrangle style).

export interface GoldenRowDiff {
  label: string;
  expected: string;
  got: string;
}

interface ParsedRow {
  full_name: string;
  email: string;
  company: string;
  ticket_type: string;
  registered_date: string;
}

function parseCsvRows(text: string): ParsedRow[] | null {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const headers = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  if (idx('email') < 0) return null;
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const cell = (name: string) => (idx(name) >= 0 ? (cells[idx(name)] ?? '').trim() : '');
    return {
      full_name: cell('full_name'),
      email: cell('email'),
      company: cell('company'),
      ticket_type: cell('ticket_type'),
      registered_date: cell('registered_date'),
    };
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function collectGoldenRowDiffs(rows: ParsedRow[]): GoldenRowDiff[] {
  const diffs: GoldenRowDiff[] = [];
  const byEmail = new Map(rows.map((r) => [r.email.toLowerCase(), r]));

  // 1. Date normalization: Rosa Kettle's 16/06/2026 phone note → 2026-06-16.
  const rosa = byEmail.get('rosa@kettleworks.example');
  if (!rosa) {
    diffs.push({
      label: 'phone-note row (rosa@kettleworks.example)',
      expected: 'present with registered_date 2026-06-16',
      got: 'row missing',
    });
  } else if (rosa.registered_date !== '2026-06-16') {
    diffs.push({
      label: 'date normalization (rosa@kettleworks.example)',
      expected: '2026-06-16',
      got: rosa.registered_date || '(empty)',
    });
  }

  // 2. Dedupe keeps the NEWEST: Otis Bramble is in the legacy CSV as
  //    standard (06-03) and re-registered VIP on 06-13.
  const otisRows = rows.filter((r) => r.email.toLowerCase() === 'otis@bramble.example');
  if (otisRows.length !== 1) {
    diffs.push({
      label: 'dedupe (otis@bramble.example)',
      expected: 'exactly one row (newest registration wins)',
      got: `${otisRows.length} rows`,
    });
  } else if (otisRows[0]!.ticket_type !== 'vip' || otisRows[0]!.registered_date !== '2026-06-13') {
    diffs.push({
      label: 'dedupe-keeps-newest (otis@bramble.example)',
      expected: 'ticket_type vip, registered_date 2026-06-13',
      got: `ticket_type ${otisRows[0]!.ticket_type || '(empty)'}, registered_date ${otisRows[0]!.registered_date || '(empty)'}`,
    });
  }

  // 3. Quoted comma: "Kettle, Rosa" must survive as a single name cell.
  if (rosa && !/kettle/i.test(rosa.full_name)) {
    diffs.push({
      label: 'quoted-comma name (rosa@kettleworks.example)',
      expected: 'full_name contains "Kettle" (e.g. "Kettle, Rosa" quoted, or Rosa Kettle)',
      got: rosa.full_name || '(empty)',
    });
  }
  return diffs;
}

export function formatGoldenDiffTable(diffs: GoldenRowDiff[]): string {
  const lines = ['| golden row | expected | got |', '|---|---|---|'];
  for (const d of diffs) lines.push(`| ${d.label} | ${d.expected} | ${d.got} |`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// Pure grader.

export function checkAttendeesCsv(csv: string): SniffResult & { goldenDiffs: GoldenRowDiff[] } {
  const signals: string[] = [];
  let failReason: string | undefined;
  const fail = (reason: string) => {
    failReason ??= reason;
  };

  const shape = csvShape(csv, {
    exactColumns: EXPECTED_COLUMNS,
    minRows: 13,
    consistentColumns: true,
    allowedValues: { ticket_type: ['standard', 'vip', 'student'] },
  });
  if (shape.ok) signals.push('csv-shape');
  else fail(`csv shape: ${shape.detail}`);

  const schema = recordSchema(csv, {
    format: 'csv',
    minRows: 13,
    uniqueBy: 'email',
    fields: [
      { name: 'id' },
      { name: 'full_name' },
      { name: 'email', type: 'email' },
      { name: 'company' },
      { name: 'ticket_type' },
      { name: 'registered_date', type: 'iso-date' },
    ],
  });
  if (schema.ok) signals.push('record-schema');
  else fail(`record schema: ${schema.detail}`);

  const rows = parseCsvRows(csv);
  const goldenDiffs = rows ? collectGoldenRowDiffs(rows) : [];
  if (rows && goldenDiffs.length === 0) signals.push('golden-rows');
  else if (rows && goldenDiffs.length > 0) {
    fail(
      `golden rows wrong: ${goldenDiffs[0]!.label} — expected ${goldenDiffs[0]!.expected}, got ${goldenDiffs[0]!.got}`,
    );
  }

  return {
    ok: signals.length >= 3,
    signals,
    score: signals.length,
    ...(failReason ? { failReason } : {}),
    goldenDiffs,
  };
}

export function recordsRepairDirective(goldenDiffs: GoldenRowDiff[]): string {
  const table = goldenDiffs.length > 0 ? `\n\n${formatGoldenDiffTable(goldenDiffs)}` : '';
  return [
    `Re-derive \`${ATTENDEES_PATH}\` from ALL THREE sources (inbox/registration-emails.txt,`,
    'notes/phone-intake.md, legacy/badge-list.csv) per schema.md. Dates normalize to',
    'YYYY-MM-DD; duplicate emails keep the NEWEST registration; comma-bearing names are',
    'quoted. Derived data is best produced by a script: write scripts/derive.mjs and run',
    'it with run_nodejs_script (or use derive_file) — do not hand-type rows.',
    table,
  ].join(' ');
}

// ─────────────────────────────────────────────────────────────────────
// User-shaped texts.

export const RECORDS_MISSION_OBJECTIVES = [
  'Consolidate every registration from inbox/registration-emails.txt,',
  'notes/phone-intake.md, and legacy/badge-list.csv into records/attendees.csv with',
  'columns exactly id,full_name,email,company,ticket_type,registered_date (at least 13',
  'rows). Dates in ISO YYYY-MM-DD; ticket_type one of standard/vip/student; duplicate',
  'emails keep the newest registration only; quote names that contain commas.',
].join(' ');

export const RECORDS_KICKOFF_MESSAGE = [
  'Please consolidate the conference registrations into one clean CSV at',
  '`records/attendees.csv` (workspace root). Sources: inbox/registration-emails.txt,',
  'notes/phone-intake.md, and legacy/badge-list.csv — schema.md declares the exact',
  'target shape. Columns exactly: id,full_name,email,company,ticket_type,registered_date.',
  'Rules: dates normalize to ISO YYYY-MM-DD; ticket_type is one of standard/vip/student',
  '(lowercase); when the same email appears in multiple sources keep only the NEWEST',
  'registration (e.g. someone who upgraded); names containing commas must be quoted.',
  'Expect at least 13 rows. Derived data is best produced by executing a script rather',
  'than hand-typing rows.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────
// Harness plumbing.

async function findProjectId(client: EvalContext['client']): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function readWorkspaceText(
  client: EvalContext['client'],
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

async function setup({ client, log }: EvalContext): Promise<void> {
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'Registration intake for the annual conference: messy multi-source sign-ups ' +
        '(emails, phone notes, a stale legacy badge list) consolidated into one clean ' +
        'attendee record per the declared schema.',
      missionObjectives: RECORDS_MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  }
  if (!projectId) throw new Error('records-intake setup: failed to resolve project id');

  for (const f of RECORDS_SEED_FILES) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${RECORDS_SEED_FILES.length} source files`);

  let clerk: { id: string };
  try {
    // Boekwachter is a template-only role (record-keeper) — the default
    // toolset groups carry workspace read+write, which is all this needs.
    const created = await client.createGezel({ name: CLERK_NAME, role: 'Boekwachter' });
    clerk = { id: created.id };
    log(`[scenario:setup] created boekwachter "${CLERK_NAME}" id=${clerk.id}`);
  } catch (err) {
    const { gezels } = await client.listGezels();
    const existing = gezels.find((g) => g.name === CLERK_NAME);
    if (!existing) throw err;
    clerk = { id: existing.id };
  }
  await client.addGezelToProject(projectId, clerk.id);
  await client.sendChatMessage(clerk.id, { message: RECORDS_KICKOFF_MESSAGE, projectId });
  log(`[scenario:setup] sent kickoff to ${CLERK_NAME}`);
}

export const recordsIntakeScenario: EvalScenario = {
  id: 'records-intake',
  description:
    'Forms-and-records precision off code: consolidate messy multi-source registrations (free-text emails, phone notes with mixed date formats, a stale legacy CSV with duplicates) into a declared record schema, graded by csvShape + recordSchema + golden-row assertions.',
  prompt: [
    `Heads up: ${CLERK_NAME} is consolidating conference registrations in the`,
    `"${PROJECT_NAME}" project. You do not need to do anything — just confirm`,
    "you've seen this note.",
  ].join(' '),
  requiredPromptEvidence: [
    { signal: 'csv-shape', pattern: /id,full_name,email,company,ticket_type,registered_date/ },
    { signal: 'record-schema', pattern: /yyyy-mm-dd/ },
    { signal: 'golden-rows', pattern: /newest registration/ },
  ],
  evidenceTexts: [RECORDS_MISSION_OBJECTIVES, RECORDS_KICKOFF_MESSAGE],
  timeoutMs: 25 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] registration project not present yet');
      return { done: false };
    }
    const csv = await readWorkspaceText(client, projectId, ATTENDEES_PATH);
    if (csv === null) {
      logChanged('sniff', `[scenario] ${ATTENDEES_PATH} not present yet`);
      recordSniff?.({ key: 'records-intake', score: 0, bytes: 0 });
      const nearMiss = await findWorkspaceDeliverableNearMiss(client, projectId, ATTENDEES_PATH);
      await postMissingDeliverableFeedback(ctx, ATTENDEES_PATH, {
        minPolls: 18,
        repeatEvery: 18,
        maxNudges: 2,
        nearMiss,
        projectId,
      });
      return { done: false };
    }
    const check = checkAttendeesCsv(csv);
    logChanged(
      'sniff',
      `[scenario] records-intake bytes=${csv.length} score=${check.score}/3 signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    recordSniff?.({ key: 'records-intake', score: check.score, bytes: csv.length });
    if (check.ok) {
      return {
        done: true,
        success: true,
        reason: `attendees.csv matches the declared schema with all golden rows (signals: ${check.signals.join(', ')})`,
      };
    }
    if (check.failReason) {
      await postSniffFeedback(ctx, ATTENDEES_PATH, check, {
        projectId,
        sourceText: csv,
        repairDirective: recordsRepairDirective(check.goldenDiffs),
      });
    }
    return { done: false };
  },
};
