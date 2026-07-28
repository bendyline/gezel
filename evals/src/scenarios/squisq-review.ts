import type { GezelClient } from '@bendyline/gezel-client/node';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Squisq code-review — clone a real GitHub repo end-to-end and produce
 * a substantive architecture + code review.
 *
 * Unlike the build scenarios, this exercises the team's ability to:
 *   1. Reach for the right tool to materialize source (`fetch_repo`).
 *   2. Walk a real, unfamiliar codebase with `list_dir` + `read_file`.
 *   3. Synthesize the read into a structured markdown report.
 *
 * Strict structural signals (chosen by the user, not the default):
 * the report must include explicit `## Architecture`, `## Major issues`,
 * `## Minor issues`, and `## Recommendations` headings; reference at
 * least 5 distinct source filenames from the cloned repo; and total
 * ≥ 5 KB. That's a higher bar than the build scenarios' "did it work"
 * checks, intentionally — a code review that doesn't cite specific
 * files is just an essay.
 *
 * The setup hook creates the project but does NOT pre-clone anything.
 * The team must call `fetch_repo` themselves; that's the "end to end"
 * the user asked for.
 */

const PROJECT_NAME = 'Squisq Code Review';
const REPO_URL = 'https://github.com/bendyline/squisq';
const fetchRepoNudgeState = new WeakMap<EvalContext, { absentPolls: number; nudgesSent: number }>();

interface FetchedSquisqProject {
  id: string;
}

async function setup({ log }: EvalContext): Promise<void> {
  // Unlike self-correction, this scenario does NOT pre-create the
  // project. The Meester's first move should be `fetch_repo` — which
  // atomically creates the project + clones the repo + links the github
  // URL. Pre-creating would defeat that test.
  log(
    '[scenario:setup] (no-op) Meester is expected to call fetch_repo to create the project + clone the source',
  );
}

/**
 * Find the review across any project's workspace OR artifacts. Real
 * trial data (squisq-review run) showed the Developer
 * landed the file at `artifacts/default/review.md` even when the
 * scenario named a different project — the Meester's delegation
 * didn't propagate the project context. We honor that by walking
 * both surfaces in every project. When multiple drafts exist, the
 * success check scores them all and uses the strongest candidate; a
 * stale weak draft in an earlier-sorted project should not hide a
 * later passing review.
 *
 * Returns the review text + a label noting where we found it (used in
 * the sniff log so the team gets credit for non-canonical locations
 * but the postmortem still shows what happened).
 */
export interface ReviewCandidate {
  text: string;
  location: string;
  projectId: string;
}

export interface ReviewScore {
  signals: string[];
  filenameCount: number;
  bytes: number;
  failReason: string | null;
}

async function findReviewCandidatesAnywhere(client: GezelClient): Promise<ReviewCandidate[]> {
  const candidates: ReviewCandidate[] = [];
  const { projects } = await client.listProjects();
  for (const project of projects) {
    // workspace/<project>/review.md
    try {
      const blob = await client.fetchProjectWorkspaceBlob(project.id, 'review.md');
      const text = await blob.text();
      if (text.trim().length > 0) {
        candidates.push({
          text,
          location: `workspace/${project.id}/review.md`,
          projectId: project.id,
        });
      }
    } catch {
      // not present, keep looking
    }
    // artifacts/<project>/review.md
    try {
      const artifact = await client.readProjectArtifact(project.id, 'review.md');
      const text = artifact.content;
      if (text.trim().length > 0) {
        candidates.push({
          text,
          location: `artifacts/${project.id}/review.md`,
          projectId: project.id,
        });
      }
    } catch {
      // not present, keep looking
    }
  }
  return candidates;
}

interface ReviewNearMiss {
  path: string;
  location: string;
  bytes: number;
}

async function readSurfaceText(
  client: GezelClient,
  projectId: string,
  surface: 'workspace' | 'artifacts',
  filePath: string,
): Promise<string | null> {
  try {
    if (surface === 'workspace') {
      const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
      return await blob.text();
    }
    const artifact = await client.readProjectArtifact(projectId, filePath);
    return artifact.content;
  } catch {
    return null;
  }
}

function isReviewNearMiss(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') && lower !== 'review.md' && lower.includes('review');
}

async function findReviewNearMissAnywhere(client: GezelClient): Promise<ReviewNearMiss | null> {
  const { projects } = await client.listProjects();
  for (const project of projects) {
    for (const surface of ['workspace', 'artifacts'] as const) {
      try {
        const listing =
          surface === 'workspace'
            ? await client.listProjectWorkspace(project.id, undefined, true)
            : await client.listProjectArtifacts(project.id, undefined, true);
        const hit = listing.files.find((f) => !f.isDirectory && isReviewNearMiss(f.name));
        if (!hit) continue;
        const text = await readSurfaceText(client, project.id, surface, hit.path);
        if (!text || text.trim().length === 0) continue;
        return {
          path: hit.path,
          location: `${surface}/${project.id}/${hit.path}`,
          bytes: text.length,
        };
      } catch {
        // Empty / nonexistent surface; keep looking.
      }
    }
  }
  return null;
}

/**
 * Count distinct source filenames mentioned in the review. We accept any
 * path-shaped token that looks like a file (has an extension, no leading
 * `http`) — backtick-fenced or inline. Cross-check that at least 5 of
 * those names plausibly come from the cloned repo by requiring the
 * basename to look like real source (alphanumeric + a real extension).
 */
function mentionedFileTokens(reviewText: string): string[] {
  const matched: string[] = [];
  // `path/to/file.ext` in backticks, or bare `something/file.ext` tokens.
  const codeFenceRe = /`([^`\s][^`]*?\.[a-z0-9]{1,6})`/gi;
  const bareRe =
    /(?:^|[\s(])((?:[\w@./-]+\/)?[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|css|html|svg|toml|sh))(?=[\s,.;:!?)\]]|$)/gim;
  for (const m of reviewText.matchAll(codeFenceRe)) matched.push(m[1] ?? '');
  for (const m of reviewText.matchAll(bareRe)) matched.push(m[1] ?? '');
  return matched.filter((name) => {
    if (!name) return false;
    if (/^https?:/i.test(name)) return false;
    if (name.length > 200) return false;
    return true;
  });
}

function normalizeMentionedPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function basename(path: string): string {
  const normalized = normalizeMentionedPath(path);
  return normalized.split('/').pop() ?? normalized;
}

const CITABLE_SOURCE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|css|html|svg|toml|sh)$/i;

async function listWorkspaceSourcePaths(client: GezelClient): Promise<string[]> {
  const out = new Set<string>();
  const { projects } = await client.listProjects();
  for (const project of projects) {
    try {
      const listing = await client.listProjectWorkspace(project.id, undefined, true);
      for (const file of listing.files) {
        if (file.isDirectory) continue;
        if (!CITABLE_SOURCE_RE.test(file.path)) continue;
        const normalized = normalizeMentionedPath(file.path);
        if (normalized === 'review.md' || normalized.endsWith('/review.md')) continue;
        out.add(normalized);
      }
    } catch {
      // Empty / nonexistent workspace; keep looking.
    }
  }
  return [...out].sort();
}

async function findFetchedSquisqProject(client: GezelClient): Promise<FetchedSquisqProject | null> {
  const { projects } = await client.listProjects();
  for (const project of projects) {
    const github = (project as { github?: { url?: string } }).github;
    if (github?.url?.replace(/\.git$/i, '') === REPO_URL) return { id: project.id };
    try {
      const packageJson = await client.fetchProjectWorkspaceBlob(project.id, 'package.json');
      const text = await packageJson.text();
      if (/"name"\s*:\s*"squisq"/i.test(text)) return { id: project.id };
    } catch {
      // Not a fetched repo workspace; keep checking the rest.
    }
  }
  return null;
}

async function postMissingFetchedRepoFeedback(ctx: EvalContext): Promise<void> {
  const current = fetchRepoNudgeState.get(ctx) ?? { absentPolls: 0, nudgesSent: 0 };
  current.absentPolls += 1;
  fetchRepoNudgeState.set(ctx, current);

  const minPolls = 12; // ~1 min: this is the first mandatory step, not deep reading.
  const repeatEvery = 24; // ~2 min between direct coordinator nudges.
  if (current.absentPolls < minPolls) return;
  if (current.nudgesSent >= 3) return;
  if (current.nudgesSent > 0 && (current.absentPolls - minPolls) % repeatEvery !== 0) return;

  const message = [
    '[scenario check] The Squisq repository has not been fetched yet. An empty `start_project` project does not contain the source and cannot pass this review.',
    `Your next tool call must be \`fetch_repo({ url: "${REPO_URL}", projectName: "${PROJECT_NAME}" })\`. Do not ask the user for source code, and do not create another empty project.`,
    'After `fetch_repo` returns a projectId, pass that projectId to any reviewer you recruit, read real files from the cloned workspace, and write `review.md` there.',
  ].join('\n\n');

  await ctx.client.sendChatMessage(ctx.meesterId, { message, projectId: 'default' });
  current.nudgesSent += 1;
  fetchRepoNudgeState.set(ctx, current);
  ctx.log(
    `[sniff-feedback] missing fetched repo nudge #${current.nudgesSent} → meester ${ctx.meesterId} (absent ${current.absentPolls} polls)`,
  );
}

export function countExistingSourceFilenameMentions(
  reviewText: string,
  actualSourcePaths: readonly string[],
): number {
  const exact = new Map<string, string>();
  const byBasename = new Map<string, string>();
  const basenameCounts = new Map<string, number>();
  for (const path of actualSourcePaths) {
    const normalized = normalizeMentionedPath(path);
    exact.set(normalized, normalized);
    exact.set(`./${normalized}`, normalized);
    const base = basename(normalized);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
    if (!byBasename.has(base)) byBasename.set(base, normalized);
  }

  const cited = new Set<string>();
  for (const token of mentionedFileTokens(reviewText)) {
    const normalized = normalizeMentionedPath(token);
    // Basename fallback only for basenames that are UNIQUE in the repo.
    // Common basenames (index.ts, types.ts, utils.ts) exist in many
    // directories, so an invented path like `lib/index.ts` would
    // otherwise count as a "real" citation — the fabrication class
    // slipping through the grader. A unique basename cited without its
    // full path is still clearly the real file.
    const base = basename(normalized);
    const canonical =
      exact.get(normalized) ??
      ((basenameCounts.get(base) ?? 0) === 1 ? byBasename.get(base) : undefined);
    if (canonical) cited.add(canonical);
  }
  return cited.size;
}

/**
 * The inverse of {@link countExistingSourceFilenameMentions}: cited
 * file tokens that match NO real workspace path (exact or unique
 * basename). These are the fabricated citations — naming them back to
 * the model is far more actionable than a generic "cite real files"
 * (wild-caught baseline: e4b cited `src/utils/helpers.ts`,
 * `tests/unit/test_runner.ts` — generic inventions — across all three
 * trials and never self-corrected on the generic warning alone).
 */
export function listFabricatedSourceMentions(
  reviewText: string,
  actualSourcePaths: readonly string[],
): string[] {
  const exact = new Set<string>();
  const basenameCounts = new Map<string, number>();
  for (const path of actualSourcePaths) {
    const normalized = normalizeMentionedPath(path);
    exact.add(normalized);
    exact.add(`./${normalized}`);
    const base = basename(normalized);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }
  const fabricated = new Set<string>();
  for (const token of mentionedFileTokens(reviewText)) {
    const normalized = normalizeMentionedPath(token);
    if (exact.has(normalized)) continue;
    if ((basenameCounts.get(basename(normalized)) ?? 0) >= 1 && !normalized.includes('/')) {
      // bare basename that exists somewhere — ambiguous, not clearly fabricated
      continue;
    }
    if ((basenameCounts.get(basename(normalized)) ?? 0) === 1) continue;
    fabricated.add(normalized);
  }
  return [...fabricated].slice(0, 4);
}

function sourcePathExamples(actualSourcePaths: readonly string[]): string[] {
  const preferred = actualSourcePaths.filter(
    (path) =>
      /(^|\/)(packages|src|tests|e2e|docs)\//.test(path) ||
      /(^|\/)(package\.json|tsconfig\.json|vite\.config\.ts|playwright\.config\.ts)$/.test(path),
  );
  return (preferred.length > 0 ? preferred : actualSourcePaths).slice(0, 8);
}

function formatExamples(paths: readonly string[]): string {
  return paths.length > 0 ? paths.map((path) => `\`${path}\``).join(', ') : 'none found yet';
}

function squisqRepairDirective(args: {
  bytes: number;
  filenameCount: number;
  sourceExamples: readonly string[];
  fabricatedExamples?: readonly string[];
}): string {
  const extraBytes = Math.max(0, 5_000 - args.bytes);
  const minAppendChars = Math.max(3_500, extraBytes + 1_000);
  const patchInstruction =
    args.filenameCount >= 5 && args.bytes < 5_000
      ? `The draft already cites enough real files. Do not replace it with a shorter version. Your next tool call must append at least ${minAppendChars} substantive characters to review.md with \`append_to_file({ path: "review.md", content: <additional sourced sections> })\`.`
      : 'Rewrite the final deliverable as the workspace file with `write_file({ path: "review.md", content: <complete review> })`, or append a substantial missing section with `append_to_file`. Do not use `write_artifact` for the shipping review.';
  return [
    'SQUISQ REVIEW PATCH: the repo is already cloned in the workspace. Do not say the source is unavailable, and do not cite assumed filenames. Assumed files do not count.',
    ...(args.fabricatedExamples && args.fabricatedExamples.length > 0
      ? [
          `These paths in your current review DO NOT EXIST and count as zero citations: ${args.fabricatedExamples.map((p) => `\`${p}\``).join(', ')}. Replace each with a real path you actually opened via read_file.`,
        ]
      : []),
    `Use real paths from the workspace. Known valid examples include: ${formatExamples(args.sourceExamples)}.`,
    'Patch the deliverable now; do not keep researching or hand the work back to chat.',
    patchInstruction,
    `The final review still needs at least 5 existing workspace file citations and at least 5000 bytes${extraBytes > 0 ? `, so add roughly ${extraBytes} more substantive characters` : ''}.`,
    'Include concrete observations under Architecture, Major issues, Minor issues, and Recommendations. Each issue should name the exact file path that supports it.',
  ].join(' ');
}

function squisqMissingReviewDirective(args: { sourceExamples?: readonly string[] } = {}): string {
  const examples = args.sourceExamples?.length
    ? ` Known valid source paths include: ${formatExamples(args.sourceExamples)}.`
    : '';
  return [
    'SQUISQ REVIEW WORKFLOW: the Squisq repo is already cloned in a project workspace. Do not call `fetch_repo` again and do not ask the user for source code.',
    'If you are the Meester and no reviewer has the work yet, your next tool call must be `ensure_gezel({ jobTitle: "Code Reviewer", whyYouNeed: "review the cloned Squisq repository and write review.md" })`; after it returns, call `message_gezel({ gezel: <returned id>, project: <this project id>, expectedDeliverable: { kind: "file", filePath: "review.md" }, message: "Write the complete Squisq architecture/code review to review.md. Include ## Architecture, ## Major issues, ## Minor issues, ## Recommendations, cite at least 5 real source paths, and make it at least 5000 bytes." })`.',
    `If you are the reviewer/developer, write the final deliverable now with \`write_file({ path: "review.md", content: <complete review> })\`.${examples}`,
  ].join(' ');
}

export function scoreSquisqReviewText(
  review: string,
  actualSourcePaths: readonly string[],
): ReviewScore {
  const signals: string[] = [];

  // Architecture-flavored top-level section: header that starts
  // with `## ` and contains "architecture" (allows "Architecture",
  // "Architecture overview", "Architecture map", "Architecture and
  // design", etc).
  if (/^## .*architecture/im.test(review)) signals.push('section-architecture');

  // Severity-ranked findings — match either a section header
  // (Major / Critical / Findings / Prioritized) OR the presence
  // of explicit severity markers anywhere in the body (P0, P1,
  // "Critical:", "Severity: High"). A review that ranks
  // findings IS a review, regardless of where the ranking lives.
  if (
    /^## .*(major|critical|findings?|prioriti[sz]ed|issues?|concerns?|problems?|risks?)\b/im.test(
      review,
    ) ||
    /^###?\s*(P0|P1|Critical|High[ -]?priority|Severity:?\s*(critical|high|major))\b/im.test(review)
  ) {
    signals.push('section-major');
  }

  // Lower-priority / nit-style findings. Same content-shape
  // logic — section header OR explicit lower-severity markers
  // anywhere in the body.
  if (
    /^## .*(minor|nits?|low[ -]?priority|polish)\b/im.test(review) ||
    /^###?\s*(P2|P3|Low[ -]?priority|Severity:?\s*(low|minor|polish))\b/im.test(review)
  ) {
    signals.push('section-minor');
  }

  // Recommendations / next steps. Codex sometimes folds these into
  // the findings section ("## Findings and recommendations") rather
  // than splitting them out; that combined header counts here.
  if (
    /^## .*(recommendations?|next[ -]?steps?|action[ -]?items?|suggested[ -]?changes?|findings?[ -]?and[ -]?recommendations?)\b/im.test(
      review,
    )
  ) {
    signals.push('section-recommendations');
  }

  const filenameCount = countExistingSourceFilenameMentions(review, actualSourcePaths);
  if (filenameCount >= 5) signals.push(`source-citations(${filenameCount})`);

  const bytes = review.length;
  if (bytes >= 5_000) signals.push(`size-ok(${bytes}B)`);

  const requiredSections = ['section-architecture', 'section-major'];
  const missingRequired = requiredSections.filter((s) => !signals.includes(s));
  const failReason =
    missingRequired.length > 0
      ? `missing required section(s): ${missingRequired.join(', ')}`
      : filenameCount < 5
        ? `only ${filenameCount} existing workspace source filenames cited (need >= 5); assumed or nonexistent filenames do not count.`
        : bytes < 5_000
          ? `review is only ${bytes} bytes (need >= 5000)`
          : null;

  return { signals, filenameCount, bytes, failReason };
}

function compareReviewScores(
  a: ReviewCandidate & ReviewScore,
  b: ReviewCandidate & ReviewScore,
): number {
  const aPass = a.failReason ? 0 : 1;
  const bPass = b.failReason ? 0 : 1;
  return (
    bPass - aPass ||
    b.signals.length - a.signals.length ||
    b.filenameCount - a.filenameCount ||
    b.bytes - a.bytes
  );
}

export function pickBestSquisqReviewCandidate(
  candidates: readonly ReviewCandidate[],
  actualSourcePaths: readonly string[],
): (ReviewCandidate & ReviewScore) | null {
  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      ...scoreSquisqReviewText(candidate.text, actualSourcePaths),
    }))
    .sort(compareReviewScores);
  return scored[0] ?? null;
}

export const squisqReviewScenario: EvalScenario = {
  id: 'squisq-review',
  description:
    'Clone https://github.com/bendyline/squisq via `fetch_repo`, walk the source, and write a structured architecture + code review at `review.md` at the workspace root. Strict signals: explicit ## Architecture / ## Major issues / ## Minor issues / ## Recommendations sections, ≥ 5 cited source filenames, ≥ 5 KB.',
  prompt: [
    `Please conduct a comprehensive architecture and code review of the open-source repository at ${REPO_URL}.`,
    '',
    `MANDATORY FIRST TOOL CALL: \`fetch_repo({ url: "${REPO_URL}", projectName: "${PROJECT_NAME}" })\`. Do not call \`start_project\`, \`start_job\`, or \`create_project\` first for this eval; those create an empty bootstrap project with no Squisq source and will fail the review.`,
    '',
    'Recommended workflow:',
    `1. First, call \`fetch_repo({ url: "${REPO_URL}", projectName: "${PROJECT_NAME}" })\`. This atomically creates a new project, links it to the github URL, and shallow-clones the source AT THE WORKSPACE ROOT of that new project. The workspace IS the cloned repo — \`list_dir('.')\` lists the repo's top-level files; \`read_file('package.json')\` returns the repo's package.json. The tool returns the new \`projectId\` — hold onto it.`,
    '2. Once the source is in place, recruit a reviewer / developer for the new project via `ensure_gezel`, then assign the review work to them with `message_gezel` — always passing `project: <the new project id>` and `expectedDeliverable: { kind: "file", filePath: "review.md" }` so they work in the right project context and write the file instead of replying in chat. Copy the concrete reviewer handoff from the `fetch_repo` tool result instead of shortening it; it includes source paths to read first and the exact acceptance criteria.',
    '3. The recruited specialist should read 5-7 high-signal source files, then write the first `review.md` draft before doing more survey work. Do not let them spend the whole turn listing directories.',
    "4. They write the review using `write_file({ path: 'review.md', content: <the full review> })`. Path is workspace-root-relative — pass just `review.md`, NOT `workspace/review.md` (which would nest at workspace/workspace/review.md). The review MUST contain these section headings, in this order, each substantial:",
    '   `## Architecture` — overview of what the codebase does, top-level structure, key modules, build/runtime layout.',
    '   `## Major issues` — concrete material concerns (correctness, security, perf, maintainability).',
    '   `## Minor issues` — nits, style, typing, doc gaps.',
    '   `## Recommendations` — prioritized actionable next steps.',
    '5. The review must cite at least 5 specific source filenames they actually read (e.g. `src/index.ts`, `package.json`). Real paths from `list_dir`, not invented.',
    '6. The final review must be at least 5 KB of substantive content.',
    "7. **Pace the work.** A 45-minute budget is plenty — start writing the review with whatever you have around the 25-minute mark. Don't leave the final `write_file` for the last 30 seconds; the review must land well before the budget is exhausted.",
    '',
    'Do not paste the review into chat — write it to `review.md` (at the workspace root) using `write_file`. The file IS the deliverable.',
  ].join('\n'),
  // No fixed `timeoutMs` — under the progress-driven runner, the trial
  // succeeds when the deliverable lands and fails when forward progress
  // stops for `progressTimeoutMs` (default 5 min). For an open-ended
  // research task like this, the model can legitimately take hours of
  // careful reading; we shouldn't bias it toward rushing by setting a
  // tight cap. The 8-hour hard ceiling is the runaway safety net.
  setup,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const candidates = await findReviewCandidatesAnywhere(client);
    if (candidates.length === 0) {
      const fetchedProject = await findFetchedSquisqProject(client);
      if (!fetchedProject) {
        logChanged(
          'repo',
          '[scenario] Squisq repo has not been fetched yet (no project.github.url match)',
        );
        recordSniff?.({ key: 'squisq-repo:fetched', score: 0, bytes: 0 });
        await postMissingFetchedRepoFeedback(ctx);
        return { done: false };
      }
      const actualSourcePaths = await listWorkspaceSourcePaths(client);
      const sourceExamples = sourcePathExamples(actualSourcePaths);
      const missingReviewDirective = squisqMissingReviewDirective({ sourceExamples });
      const nearMiss = await findReviewNearMissAnywhere(client);
      if (nearMiss) {
        logChanged(
          'file',
          `[scenario] review.md not present yet; near-miss ${nearMiss.location} bytes=${nearMiss.bytes}`,
        );
        recordSniff?.({
          key: `review.md:near-miss:${nearMiss.location}`,
          score: 0,
          bytes: nearMiss.bytes,
        });
        await postMissingDeliverableFeedback(ctx, 'review.md', {
          nearMiss,
          projectId: fetchedProject.id,
          coordinatorFallbackAfterPolls: 60,
          targetGracePolls: 12,
          repeatEvery: 60,
          repairDirective: missingReviewDirective,
        });
        return { done: false };
      }
      logChanged(
        'file',
        '[scenario] review.md not present yet (checked workspace + artifacts of all projects)',
      );
      // Report the "nothing yet" state to the fingerprint so the
      // no-progress watchdog knows the bytes/score are still at zero.
      recordSniff?.({ key: 'review.md', score: 0, bytes: 0 });
      // Read-then-never-write stall: once the team has had a reading grace
      // period, directive-nudge it to actually write review.md. squisq
      // previously posted NO scenario feedback at all — the
      // qwen3.5 trials fetched the repo and stalled without ever writing.
      await postMissingDeliverableFeedback(ctx, 'review.md', {
        projectId: fetchedProject.id,
        coordinatorFallbackAfterPolls: 60,
        targetGracePolls: 12,
        repeatEvery: 60,
        repairDirective: missingReviewDirective,
      });
      return { done: false };
    }
    const actualSourcePaths = await listWorkspaceSourcePaths(client);
    const sourceExamples = sourcePathExamples(actualSourcePaths);
    const found = pickBestSquisqReviewCandidate(candidates, actualSourcePaths)!;
    const { signals, filenameCount, bytes } = found;

    // Two structural sections are required, treated as the "this is
    // a real review" gate:
    //   1. SOME architecture section (any phrasing of "Architecture")
    //   2. SOME severity-ranked findings (either a Major/Critical/
    //      Findings/Prioritized header, OR explicit P0/P1/Severity
    //      markers anywhere in the body)
    //
    // The minor + recommendations signals become BONUS: real
    // reviews often fold those in (codex routinely combines
    // "Findings and recommendations" into one section, or omits a
    // separate "Minor" header when severity-ranking already covers
    // low-priority items inline). Three codex-cli runs
    // each picked different organizational styles for substantive
    // reviews; gating on 3-of-4 or 4-of-4 sections was burning
    // money on retries of clearly-correct work.
    //
    // The size + citation gates stay strict — they measure
    // substance, which the structural style can't fake.
    const failReason = found.failReason?.startsWith('only ')
      ? `only ${filenameCount} existing workspace source filenames cited (need >= 5); assumed or nonexistent filenames do not count. Real examples available: ${sourceExamples.join(', ') || 'none'}`
      : found.failReason;

    logChanged(
      'sniff',
      `[scenario] ${found.location} bytes=${bytes} signals=${signals.join(',') || 'none'} citations=${filenameCount}${failReason ? ` failReason="${failReason}"` : ''}`,
    );

    // Surface to the fingerprint: each new byte / signal / citation
    // counts as forward progress, so a team that's actively growing the
    // review (10 KB → 15 KB → 20 KB) doesn't trip the stall watchdog
    // even though they haven't crossed the success bar yet.
    recordSniff?.({
      key: 'review.md',
      score: signals.length,
      bytes,
    });

    if (!failReason) {
      return {
        done: true,
        success: true,
        reason: `${found.location} passed structural sniff (signals: ${signals.join(', ')})`,
      };
    }
    // review.md exists but misses a required signal — forward the specific
    // gap so the team can patch it. Parity with incident-postmortem;
    // previously squisq posted no feedback and a model one signal short
    // would stall with no idea what to fix.
    const missingRequiredSignals = [
      ...['section-architecture', 'section-major'].filter((s) => !signals.includes(s)),
      ...(filenameCount < 5
        ? [`source-citations (have ${filenameCount}/5 existing workspace files)`]
        : []),
      ...(bytes < 5_000 ? [`size-ok (have ${bytes}/5000B)`] : []),
    ];
    await postSniffFeedback(
      ctx,
      found.location,
      {
        ok: false,
        signals,
        score: signals.length,
        failReason,
        missingRequiredSignals,
      },
      {
        repairDirective: squisqRepairDirective({
          bytes,
          filenameCount,
          sourceExamples,
          fabricatedExamples: listFabricatedSourceMentions(found.text, actualSourcePaths),
        }),
      },
    );
    return { done: false };
  },
};
