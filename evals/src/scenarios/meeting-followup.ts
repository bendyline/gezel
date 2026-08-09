import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { containsUnqualifiedClaim } from './claim-guards.ts';
import { findWorkspaceDeliverableNearMiss, provisionScenarioGezel } from './helpers.ts';

/**
 * Office-shaped extraction and follow-through task. A noisy transcript and
 * stale agenda must become both a human brief and a machine-usable action
 * register without upgrading proposals into decisions or losing dependency
 * structure.
 */

const PROJECT_NAME = 'Orchid Launch Follow-up';
const COORDINATOR_NAME = 'Noor';
export const MEETING_BRIEF_PATH = 'meeting-brief.md';
export const ACTION_ITEMS_PATH = 'action-items.csv';

export const MEETING_SEED_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'meeting/transcript.md',
    content: [
      '# Orchid launch working session — 2026-08-27',
      '',
      '**Jordan Lee:** The September 7 date in the old agenda is no longer realistic.',
      'Can we lock September 14 for phase one?',
      '',
      '**Priya Raman:** Yes, if phase one is EU only. A global launch is not approved.',
      'For migration, we agreed on one overnight batch rather than a rolling migration.',
      "I can run the migration dry-run by 2026-09-02, but I need Morgan's field map first.",
      '',
      '**Morgan Ivers:** I own the billing export field map. I will publish it by',
      "2026-08-29. That unblocks Priya's dry-run.",
      '',
      '**Luis Ortega:** I will draft the status-page and customer-email copy by',
      '2026-09-03. Legal review is still unscheduled, so that remains a risk.',
      '',
      '**Jordan:** Decision recap: September 14, EU-only phase one, one overnight batch.',
      'We did NOT decide whether the annual plan ships in phase one. I will schedule a',
      'separate annual-plan decision review by 2026-08-30.',
      '',
      '**Priya:** One more open question: who owns rollback communications? No owner today.',
    ].join('\n'),
  },
  {
    path: 'meeting/roster.md',
    content: [
      '# Current roster',
      '',
      '- Jordan Lee — launch lead',
      '- Priya Raman — migration lead',
      '- Morgan Ivers — billing systems',
      '- Luis Ortega — customer communications',
      '',
      'Only these people may be assigned action items from this meeting.',
    ].join('\n'),
  },
  {
    path: 'meeting/old-agenda.md',
    content: [
      '# STALE agenda draft — superseded by the transcript',
      '',
      '- Proposed launch: 2026-09-07.',
      '- Proposed scope: global launch.',
      '- Proposed migration: rolling by region.',
      '- Proposed owner for rollback communications: Casey.',
      '',
      'These were pre-meeting proposals, not decisions.',
    ].join('\n'),
  },
];

export const MEETING_MISSION = [
  'Turn the August 27 transcript into meeting-brief.md and action-items.csv.',
  'The brief must have Decisions, Action items, Open questions, and Risks and dependencies',
  'sections. The CSV header must be id,owner,action,due_date,depends_on,status with exactly',
  'four rows A1-A4. Use the transcript as authority over the stale agenda; keep unresolved',
  'topics unresolved and never assign an owner who is absent from the current roster.',
].join(' ');

export const MEETING_KICKOFF = [
  'Read `meeting/transcript.md`, `meeting/roster.md`, and the explicitly stale',
  '`meeting/old-agenda.md`. Create two workspace-root deliverables:',
  '`meeting-brief.md` and `action-items.csv`. The brief needs H2 sections in this order:',
  'Decisions; Action items; Open questions; Risks and dependencies. Distinguish decisions',
  'from proposals and keep the annual-plan question and rollback-communications owner open.',
  'The CSV header must be exactly `id,owner,action,due_date,depends_on,status` and contain',
  "exactly four rows: A1 Morgan's billing field map due 2026-08-29; A2 Priya's migration",
  "dry-run due 2026-09-02 and dependent on A1; A3 Luis's status-page and customer-email",
  "copy due 2026-09-03; A4 Jordan's annual-plan decision review due 2026-08-30.",
  'Use full roster names and status `todo` for every row. Leave `depends_on` empty for any',
  'row that depends on nothing. Write both files now.',
].join(' ');

/**
 * A parsed CSV row, keyed by whatever header the model actually wrote.
 *
 * Deliberately NOT a fixed-field interface: a model that renames a column
 * ("due" for "due_date") fails `csv-header`, but the row checks still have
 * to run and report, so every column access has to survive a missing key.
 * Typing this as the ideal shape made `row.due_date.trim()` a crash that
 * escaped `successCheck` and killed the trial instead of grading it.
 */
type ActionRow = Record<string, string>;

function cell(row: ActionRow | undefined, name: string): string {
  return row?.[name] ?? '';
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseActionRows(csv: string): {
  header: string[];
  rows: ActionRow[];
  rowWidths: number[];
} {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = splitCsvLine(lines[0] ?? '').map((cell) => cell.toLowerCase());
  const rowCells = lines.slice(1).map((line) => splitCsvLine(line));
  const rows = rowCells.map(
    (cells): ActionRow =>
      Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])),
  );
  return { header, rows, rowWidths: rowCells.map((cells) => cells.length) };
}

const STALE_CLAIM =
  /(?:september\s+7|2026-09-07)|global launch|casey[\s\S]{0,80}rollback|rollback[\s\S]{0,80}casey/i;
const STALE_REJECTION_CONTEXT =
  /reject|stale|supersed|proposal|not approved|no longer|did not decide|isn['’]?t|is not|wasn['’]?t|was not/i;

/**
 * The two deliverables are graded together but repaired separately, so
 * every signal declares which file a model would have to edit to fix it.
 * Without this the repair target was inferred by grepping the failure
 * message, and because the brief's checks run first and `failReason` is
 * first-wins, a trial with both files broken could never be steered at the
 * CSV until the brief was already perfect.
 */
type MeetingArtifact = 'brief' | 'csv';

/** Result of one deliverable check, plus the file that owns its repair. */
interface MeetingSignalOutcome {
  signal: string;
  artifact: MeetingArtifact;
  ok: boolean;
  reason: string;
}

export interface MeetingFollowupResult extends SniffResult {
  /** Deliverable owning the first unmet signal; drives the repair nudge. */
  repairArtifact: MeetingArtifact;
}

export function checkMeetingFollowup(markdown: string, csv: string): MeetingFollowupResult {
  const outcomes: MeetingSignalOutcome[] = [];
  const check = (signal: string, artifact: MeetingArtifact, ok: boolean, reason: string) =>
    outcomes.push({ signal, artifact, ok, reason });

  const sectionNames = ['Decisions', 'Action items', 'Open questions', 'Risks and dependencies'];
  const positions = sectionNames.map((name) =>
    markdown.search(new RegExp(`^##\\s+${name}\\s*$`, 'im')),
  );
  check(
    'ordered-sections',
    'brief',
    positions.every((position) => position >= 0) &&
      positions.every((p, i) => i === 0 || p > positions[i - 1]!),
    `meeting brief needs ordered H2 sections: ${sectionNames.join(', ')}`,
  );

  check(
    'launch-decision',
    'brief',
    /september\s+14|2026-09-14/i.test(markdown) && /eu[- ]only|phase one[^.\n]*eu/i.test(markdown),
    'missing the September 14, EU-only phase-one decision',
  );
  check(
    'migration-decision',
    'brief',
    /overnight batch/i.test(markdown) && /rolling/i.test(markdown),
    'state that one overnight batch won over the rolling proposal',
  );

  check(
    'annual-plan-open',
    'brief',
    /annual plan[\s\S]{0,180}(?:open|not decided|undecided|unresolved)/i.test(markdown),
    'the annual-plan scope must remain explicitly unresolved',
  );
  check(
    'rollback-owner-open',
    'brief',
    /rollback communications?[\s\S]{0,140}(?:unassigned|no owner|owner[^.\n]*open|tbd)/i.test(
      markdown,
    ),
    'rollback communications must remain unassigned',
  );
  check(
    'legal-risk',
    'brief',
    /legal review[\s\S]{0,100}(?:risk|unscheduled|not scheduled|open)/i.test(markdown),
    'name the unscheduled legal review as a risk',
  );
  check(
    'stale-proposals-rejected',
    'brief',
    !containsUnqualifiedClaim(markdown, STALE_CLAIM, STALE_REJECTION_CONTEXT),
    'a stale agenda proposal leaked into the current decisions or assignments',
  );

  const parsed = parseActionRows(csv);
  const expectedHeader = ['id', 'owner', 'action', 'due_date', 'depends_on', 'status'];
  check(
    'csv-header',
    'csv',
    parsed.header.join(',') === expectedHeader.join(',') &&
      parsed.rowWidths.every((width) => width === expectedHeader.length),
    `CSV header must be exactly ${expectedHeader.join(',')}`,
  );

  check(
    'four-actions',
    'csv',
    parsed.rows.length === 4 &&
      parsed.rows.map((row) => cell(row, 'id')).join(',') === 'A1,A2,A3,A4',
    `expected exactly rows A1-A4; got ${parsed.rows.map((row) => cell(row, 'id')).join(',') || 'none'}`,
  );

  const expected = [
    {
      id: 'A1',
      owner: 'Morgan Ivers',
      due: '2026-08-29',
      dependency: '',
      action: /billing[\s-]*(?:export)?[\s-]*field map/i,
    },
    {
      id: 'A2',
      owner: 'Priya Raman',
      due: '2026-09-02',
      dependency: 'A1',
      action: /migration[\s-]*dry[\s-]*run/i,
    },
    {
      id: 'A3',
      owner: 'Luis Ortega',
      due: '2026-09-03',
      dependency: '',
      action:
        /status[\s-]*page[\s\S]*customer[\s-]*email|customer[\s-]*email[\s\S]*status[\s-]*page/i,
    },
    {
      id: 'A4',
      owner: 'Jordan Lee',
      due: '2026-08-30',
      dependency: '',
      action: /annual[\s-]*plan[\s\S]*decision[\s-]*review/i,
    },
  ];
  // One signal PER ROW rather than a single all-or-nothing register gate.
  // The sniff score feeds the runner's progress fingerprint, so a flat
  // score across "0 of 4 rows right" and "3 of 4 rows right" reads to the
  // retry-loop watchdog as a team making no progress while it is in fact
  // converging — and the repair nudge can name the one row still wrong.
  for (const wanted of expected) {
    const actual = parsed.rows.find((row) => cell(row, 'id') === wanted.id);
    const wrong: string[] = [];
    if (!actual) {
      wrong.push('row missing');
    } else {
      if (!sameName(cell(actual, 'owner'), wanted.owner)) {
        wrong.push(`owner (want "${wanted.owner}")`);
      }
      if (cell(actual, 'due_date').trim() !== wanted.due)
        wrong.push(`due_date (want ${wanted.due})`);
      if (normalizeDependency(cell(actual, 'depends_on')) !== wanted.dependency) {
        wrong.push(`depends_on (want ${wanted.dependency === '' ? 'empty' : wanted.dependency})`);
      }
      if (cell(actual, 'status').trim().toLowerCase() !== 'todo') wrong.push('status (want todo)');
      if (!wanted.action.test(cell(actual, 'action'))) wrong.push('action text');
    }
    check(
      `action-row-${wanted.id.toLowerCase()}`,
      'csv',
      wrong.length === 0,
      `row ${wanted.id} is wrong: ${wrong.join('; ')}`,
    );
  }

  const signals = outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.signal);
  const unmet = outcomes.filter((outcome) => !outcome.ok);
  const first = unmet[0];
  return {
    ok: unmet.length === 0,
    signals,
    score: signals.length,
    scoreMax: outcomes.length,
    repairArtifact: first?.artifact ?? 'brief',
    ...(first
      ? { failReason: first.reason, missingRequiredSignals: unmet.map((o) => o.signal) }
      : {}),
  };
}

/** Roster names are compared on content, not on the model's capitalization or spacing. */
function sameName(actual: string, expected: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalize(actual) === normalize(expected);
}

/**
 * A row that depends on nothing may say so with an empty cell or with any
 * of the conventional "no value" fillers. The kickoff asks for empty, but
 * failing a structurally correct register over `-` vs `` measures
 * spreadsheet dialect, not meeting comprehension.
 */
function normalizeDependency(value: string): string {
  const trimmed = value.trim();
  if (/^(?:|-|--|—|–|n\/?a|none|null|nil)$/i.test(trimmed)) return '';
  return trimmed.toUpperCase();
}

async function findProjectId(client: EvalContext['client']): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((project) => project.name === PROJECT_NAME)?.id ?? null;
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

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'Meeting follow-through for the Orchid launch. The transcript is authoritative; the old agenda contains superseded proposals.',
      missionObjectives: MEETING_MISSION,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  }
  if (!projectId) throw new Error('meeting-followup setup: failed to resolve project id');

  for (const file of MEETING_SEED_FILES) {
    await client.writeProjectWorkspaceFile(projectId, file);
  }
  log(`[scenario:setup] seeded ${MEETING_SEED_FILES.length} meeting files`);

  const coordinator = await provisionScenarioGezel(ctx, {
    preferredName: COORDINATOR_NAME,
    role: 'Planner',
    label: 'coordinator',
  });
  await client.addGezelToProject(projectId, coordinator.id);
  // The Planner role ships NO workspace-fs groups (core role registry), so
  // these installs are what make a file deliverable reachable at all.
  //
  // Installing builtin toolsets REPLACES the role default rather than
  // adding to it (`toolsetsGroupOverride` in the service's role-tool
  // filter), so this list is the gezel's entire builtin roster. That is
  // deliberate: it matches what the wikipedia-research researcher gets, so
  // the two new scenarios present the same tool-block size and neither is
  // scored against a wider roster than the other. Adding a group here
  // changes what the model sees on every turn — do it knowingly.
  for (const toolsetId of ['builtin.workspace-fs-read', 'builtin.workspace-fs-write']) {
    await client.installToolset(toolsetId, { scope: { kind: 'gezel', gezelId: coordinator.id } });
  }
  await client.sendChatMessage(coordinator.id, { message: MEETING_KICKOFF, projectId });
  log(`[scenario:setup] sent meeting follow-up kickoff to ${coordinator.name}`);
}

export const meetingFollowupScenario: EvalScenario = {
  id: 'meeting-followup',
  description:
    'Meeting-to-execution task: reconcile a noisy transcript with a stale agenda and current roster, then produce a decision brief plus an exact machine-readable action register with owners, dates, dependencies, unresolved questions, and risks preserved.',
  prompt: [
    `${COORDINATOR_NAME} is preparing the follow-up in the "${PROJECT_NAME}" project.`,
    'No Meester action is needed; just acknowledge this note.',
  ].join(' '),
  requiredPromptEvidence: [
    {
      signal: 'ordered-sections',
      pattern: /decisions[\s\S]*action items[\s\S]*open questions[\s\S]*risks and dependencies/,
    },
    { signal: 'launch-decision', pattern: /september 14[\s\S]*eu[- ]only/ },
    {
      signal: 'migration-decision',
      pattern: /(?:overnight batch[\s\S]*rolling|rolling[\s\S]*overnight batch)/,
    },
    { signal: 'four-actions', pattern: /exactly four rows/ },
    { signal: 'action-row-a1', pattern: /a1 morgan[^;]*2026-08-29/ },
    { signal: 'action-row-a2', pattern: /a2 priya[^;]*2026-09-02[^;]*dependent on a1/ },
    { signal: 'action-row-a3', pattern: /a3 luis[^;]*2026-09-03/ },
    { signal: 'action-row-a4', pattern: /a4 jordan[^;]*2026-08-30/ },
    // The register also requires status `todo` and an empty `depends_on`
    // on the three independent rows. Both are grader predicates, so both
    // must be stated in the kickoff or the gate is unwinnable — that is
    // exactly the arcade-deluxe failure class this lint exists to catch.
    { signal: 'action-row-a1', pattern: /status `todo` for every row/ },
    { signal: 'action-row-a1', pattern: /leave `depends_on` empty/ },
    { signal: 'annual-plan-open', pattern: /annual-plan question[\s\S]*open/ },
    { signal: 'rollback-owner-open', pattern: /rollback communications[\s\S]*no owner/ },
    { signal: 'legal-risk', pattern: /legal review[\s\S]*risk/ },
    { signal: 'csv-header', pattern: /id,owner,action,due_date,depends_on,status/ },
    { signal: 'stale-proposals-rejected', pattern: /stale agenda[\s\S]*not decisions/ },
  ],
  evidenceTexts: [
    MEETING_MISSION,
    MEETING_KICKOFF,
    ...MEETING_SEED_FILES.map((file) => file.content),
  ],
  timeoutMs: 30 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  judge: {
    artifactBasename: MEETING_BRIEF_PATH,
    artifactKind: 'markdown',
    contextNote:
      'The August 27 transcript is authoritative; old-agenda.md contains rejected proposals that must not become decisions.',
    axes: [
      {
        name: 'decisionClarity',
        description: 'Separates decisions, open questions, actions, and risks cleanly.',
      },
      {
        name: 'grounding',
        description: 'Owners, dates, scope, and dependencies match the transcript and roster.',
      },
      {
        name: 'actionability',
        description: 'A reader can execute the follow-up without rereading the transcript.',
      },
      {
        name: 'brevity',
        description: 'The brief is scannable and avoids transcript-style repetition.',
      },
    ],
  },
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const projectId = await findProjectId(ctx.client);
    if (!projectId) {
      ctx.logChanged('project', '[scenario] meeting-followup project not present yet');
      return { done: false };
    }
    const [markdown, csv] = await Promise.all([
      readWorkspaceText(ctx.client, projectId, MEETING_BRIEF_PATH),
      readWorkspaceText(ctx.client, projectId, ACTION_ITEMS_PATH),
    ]);
    if (markdown === null || csv === null) {
      const missingPath = markdown === null ? MEETING_BRIEF_PATH : ACTION_ITEMS_PATH;
      ctx.logChanged('sniff', `[scenario] ${missingPath} not present yet`);
      ctx.recordSniff?.({
        key: 'meeting-followup',
        score: markdown === null && csv === null ? 0 : 1,
        bytes: (markdown?.length ?? 0) + (csv?.length ?? 0),
        repairFilePath: missingPath,
      });
      const nearMiss = await findWorkspaceDeliverableNearMiss(ctx.client, projectId, missingPath);
      await postMissingDeliverableFeedback(ctx, missingPath, {
        minPolls: 18,
        repeatEvery: 18,
        maxNudges: 2,
        nearMiss,
        projectId,
      });
      return { done: false };
    }

    const check = checkMeetingFollowup(markdown, csv);
    const repairPath = check.repairArtifact === 'csv' ? ACTION_ITEMS_PATH : MEETING_BRIEF_PATH;
    ctx.logChanged(
      'sniff',
      `[scenario] meeting-followup bytes=${markdown.length + csv.length} score=${check.score}/${check.scoreMax} signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    ctx.recordSniff?.({
      key: 'meeting-followup',
      score: check.score,
      bytes: markdown.length + csv.length,
      repairFilePath: repairPath,
      ...(check.failReason ? { failReason: check.failReason } : {}),
    });
    if (check.ok) {
      return {
        done: true,
        success: true,
        reason: `meeting brief and action register pass all reconciliation gates (${check.signals.join(', ')})`,
      };
    }
    if (check.failReason) {
      await postSniffFeedback(ctx, repairPath, check, {
        projectId,
        sourceText: repairPath === ACTION_ITEMS_PATH ? csv : markdown,
        repairDirective: `Re-read meeting/transcript.md and meeting/roster.md, then patch only ${repairPath} to fix the named gap. The old agenda is not authoritative.`,
      });
    }
    return { done: false };
  },
};
