/**
 * Kickoff-text policy for the meester macros (start_project / start_job
 * and the promoted-job path) — extracted from server.ts for testability
 * (pattern: solo-loop-policy.ts, repo-intake-policy.ts).
 *
 * Single-channel kickoff (D1): there is no separate chat notification
 * anymore — the worker starts in a task-scoped entry handoff whose
 * system prompt carries the task description + step prompt + gate
 * contract. Everything the old notify text used to steer therefore
 * lives HERE, in the task description and step description these
 * builders produce. Keep the steering imperative and deduplicated:
 * these strings ride the system prompt of every task turn, not a
 * one-shot chat bubble.
 */

export function macroLooksLikeBuildMission(
  name: string,
  about: string,
  missionObjectives: string,
): boolean {
  const text = `${name}\n${about}\n${missionObjectives}`.toLowerCase();
  return /\b(game|website|web\s+site|site|app|application|dashboard|ui|page|browser|html|prototype|tool)\b/.test(
    text,
  );
}

export function shouldAppendDeliverableGuard(taskDescription: string): boolean {
  // Single-channel kickoff: the task description is the ONLY carrier of
  // the deliverable guard now (the chat notify that used to guarantee it
  // is gone), so suppress only when the description already contains
  // guard-shaped text itself. Merely mentioning `workspace/index.html`
  // must NOT suppress — that's precisely the brief that triggers the
  // wrong-path bug the guard corrects.
  return !/\bwritefile\s*\(/i.test(taskDescription);
}

export function macroNeedsImageAsset(
  name: string,
  about: string,
  missionObjectives: string,
  taskDescription = '',
): boolean {
  const text = `${name}\n${about}\n${missionObjectives}\n${taskDescription}`.toLowerCase();
  return /\b(logo|image|png|photo|illustration|generated image|ai-generated)\b/.test(text);
}

export function inferImageDeliverablePath(input: {
  name: string;
  about: string;
  missionObjectives: string;
  taskDescription?: string;
}): string {
  const text = `${input.name}\n${input.about}\n${input.missionObjectives}\n${input.taskDescription ?? ''}`;
  const candidates = [
    ...text.matchAll(
      /(?:^|[\s`"'])((?:[\w.-]+\/)*[\w.-]+\.(?:png|jpe?g|webp|gif))(?:[\s`"',).]|$)/gi,
    ),
  ]
    .map((match) => match[1])
    .filter((path): path is string => !!path && !/^\.\.?[\\/]/.test(path));
  candidates.sort((a, b) => imagePathRank(b) - imagePathRank(a) || a.localeCompare(b));
  return candidates[0] ?? 'assets/logo.png';
}

function imagePathRank(path: string): number {
  const lower = path.toLowerCase();
  let score = 0;
  if (lower.includes('/')) score += 2;
  if (lower.includes('assets/')) score += 3;
  if (lower.includes('logo')) score += 2;
  return score;
}

/**
 * The kickoff task description — the standing brief every step session
 * reads under `### Current task`. Carries the deliverable guard, the
 * image-asset recipe (migrated from the old notify text — the crew's
 * voorman reads it here now), and the meester's optional custom note.
 */
export function buildKickoffTaskDescription(input: {
  name: string;
  about: string;
  missionObjectives: string;
  taskDescription?: string;
  /**
   * The meester's optional custom kickoff message (the old
   * `kickoffMessage` macro arg). Folded into the task description so
   * the worker reads it in their task-scoped session — the old
   * separate chat delivery is gone.
   */
  kickoffNote?: string;
}): string {
  const base =
    input.taskDescription ??
    `Initial setup for "${input.name}". Read the project about and mission objectives, then make the first concrete move toward the success criteria.`;
  const note = input.kickoffNote?.trim()
    ? `\n\nNote from the meester: ${input.kickoffNote.trim()}`
    : '';
  if (
    !macroLooksLikeBuildMission(input.name, input.about, input.missionObjectives) ||
    !shouldAppendDeliverableGuard(base)
  ) {
    return `${base}${note}`;
  }
  const imageGuard = macroNeedsImageAsset(
    input.name,
    input.about,
    input.missionObjectives,
    input.taskDescription,
  )
    ? (() => {
        const imagePath = inferImageDeliverablePath(input);
        return ` This task also needs a generated image/PNG/logo in this same project/workspace — do not create a separate logo/image project. Hand it off as a file deliverable: call ensure_gezel for an image-generator, then message_gezel with that gezel and expectedDeliverable: { kind: "file", filePath: "${imagePath}" }; the image-generator renders it via \`generate_image({ prompt, saveAs: "${imagePath}" })\`. Then reference it from the HTML exactly as \`<img src="${imagePath}">\`. The task is not complete until the image file exists in this workspace and the HTML references it; a designer mockup alone does not satisfy the image requirement.`;
      })()
    : '';
  return `${base}\n\nImportant: planning is not the deliverable. This task is not complete until the requested app/game/site exists as a real file in the project workspace. If the user named a path, preserve it in the brief; when using the workspace \`write_file\` tool, pass the path relative to the workspace root (for browser games/sites this is usually \`write_file({ path: "index.html", content: "..." })\`, not \`workspace/index.html\`). First pass target: concise but substantive, no frameworks, no external assets, real event handlers, real state, and the named gameplay/app behavior. Do not impose an artificial byte/line cap, do not pad with comments, and do not revise or debate inside the file; emit one clean final version. Verify it before closing. In crew projects, the owner for index.html or other source files must be a Developer/Builder; Designers may advise or create assets, but they are not the shipping source-file owner.${imageGuard}${note}`;
}

/**
 * The ad-hoc "Plan and execute" step description (the no-craftbook-pin
 * fallback). For crew builds it carries the file-handoff delegation
 * recipe migrated from the old notify text — the voorman reads it in
 * their entry-step session now.
 */
export function buildKickoffStepDescription(
  input: {
    name: string;
    about: string;
    missionObjectives: string;
  },
  opts: { isCrew?: boolean } = {},
): string {
  if (!macroLooksLikeBuildMission(input.name, input.about, input.missionObjectives)) {
    return 'Read the project about + mission objectives + task description above, then make the first concrete move.';
  }
  const crewDelegation = opts.isCrew
    ? ' If you delegate a required file, use a file handoff, not a plain queued note or Q&A: call ensure_gezel for a Builder/Developer, then call message_gezel with that gezel and expectedDeliverable: { kind: "file", filePath: "index.html" }. That specialist must write_file before replying. For index.html or source files, do not ask a Designer to paste HTML/CSS in chat. Do not only assign the task, write notes, ask for wireframes, request an architecture proposal, or call ask_specialist for a file deliverable.'
    : '';
  return `Start with the first shippable workspace file or a concrete specialist handoff for that file. Do not spend this step on wireframes, architecture proposals, task notes, or plans unless those are the requested deliverable.${crewDelegation}`;
}

// Code/doc/data extensions plus raster+svg images — an image IS the primary
// deliverable for render/logo briefs (tool-routing names `workspace/sunset.png`),
// and policyForDeliverable gives any non-HTML deliverable the file-exists
// `nonempty` gate, which is the right floor for a generated PNG. Briefs that
// name BOTH (petshop: index.html + assets/logo.png) infer the first-named =
// the primary page, so adding images here doesn't steal those.
export const DELIVERABLE_EXT =
  'html|css|js|ts|tsx|jsx|mjs|cjs|md|json|ndjson|yaml|yml|csv|tsv|py|png|jpe?g|webp|gif|svg';

export function inferSourceDeliverablePath(input: {
  name: string;
  about: string;
  missionObjectives: string;
  taskDescription?: string;
}): string | undefined {
  const text = `${input.name}\n${input.about}\n${input.missionObjectives}\n${input.taskDescription ?? ''}`;
  // An explicitly-named deliverable file is the STRONGEST signal — stronger
  // than the build-mission keyword heuristic below, which only knows
  // games/sites/apps/pages and misses code deliverables (a TS library, an API
  // module, a data file). Try it FIRST, regardless of keywords. Wild-caught
  // Wild-caught: interface-contract's brief names `src/types.ts` /
  // `src/producer.ts` but "TypeScript event pipeline" matched no keyword, so
  // inference was skipped and the deliverable gate defaulted to index.html —
  // a file the model never writes, so the gate never fired for a 3-file TS
  // deliverable. The `(` in the leading-char class catches "(e.g. `src/x.ts`)".
  const explicit =
    text.match(
      new RegExp(`\\bworkspace\\/([A-Za-z0-9._/-]+\\.(?:${DELIVERABLE_EXT}))\\b`, 'i'),
    )?.[1] ??
    text.match(
      new RegExp(
        `(?:^|[\\s\`"'(])((?:[\\w.-]+\\/)*[\\w.-]+\\.(?:${DELIVERABLE_EXT}))(?:[\\s\`"',).]|$)`,
        'i',
      ),
    )?.[1];
  if (explicit) return explicit.replace(/^workspace\//i, '');
  // No explicit path named: fall back to the keyword heuristic + the
  // index.html default, which only makes sense for recognizable browser
  // builds (a game/site/app with no file named yet → it'll be index.html).
  if (!macroLooksLikeBuildMission(input.name, input.about, input.missionObjectives)) {
    return undefined;
  }
  return 'index.html';
}

export function shouldPromoteStartJobToProject(input: {
  name: string;
  about: string;
  missionObjectives: string;
  taskDescription?: string;
}): boolean {
  return (
    macroLooksLikeBuildMission(input.name, input.about, input.missionObjectives) &&
    macroNeedsImageAsset(input.name, input.about, input.missionObjectives, input.taskDescription)
  );
}

/**
 * Runtime guard for a small model that selected the crew macro despite a
 * clearly solo brief. Ambiguous apps remain crew-shaped; redirect only
 * when the text explicitly says small/single/prototype/browser-game, or
 * names exactly one deliverable file, and contains no multi-discipline
 * signal.
 */
export function shouldRouteStartProjectToJob(input: {
  name: string;
  about: string;
  missionObjectives: string;
  taskDescription?: string;
}): boolean {
  if (shouldPromoteStartJobToProject(input)) return false;
  const text =
    `${input.name}\n${input.about}\n${input.missionObjectives}\n${input.taskDescription ?? ''}`.toLowerCase();
  if (
    /\b(crew|team of|multiple specialists|multi[- ]discipline|multimodal|frontend and backend|code and tests|tests and docs|research and build)\b/.test(
      text,
    )
  ) {
    return false;
  }

  const explicitPaths = new Set(
    [
      ...text.matchAll(
        new RegExp(`\\b(?:workspace\\/)?[\\w./-]+\\.(?:${DELIVERABLE_EXT})\\b`, 'gi'),
      ),
    ]
      .map((match) => match[0]?.replace(/^workspace\//i, ''))
      .filter((path): path is string => Boolean(path)),
  );
  if (explicitPaths.size > 1) return false;
  if (explicitPaths.size === 1) return true;

  return /\b(single[- ]file|one[- ]file|one file|small browser|simple browser|browser game|quick prototype|small prototype|one[- ]shot prototype|tiny (?:game|site|app))\b/.test(
    text,
  );
}
