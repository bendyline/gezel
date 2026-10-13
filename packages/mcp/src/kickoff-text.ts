/**
 * Kickoff-text policy for the meester project kickoff — extracted from
 * server.ts for testability
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

// Code/doc/data extensions plus raster+svg images and capability-owned binary
// formats. Binary paths are detected here so start_project can route them to
// their exact production craftbook before the generic build-loop fallback.
// Briefs that name BOTH (petshop: index.html + assets/logo.png) infer the
// first-named path, so adding formats here doesn't steal those.
export const DELIVERABLE_EXT =
  'html|css|js|ts|tsx|jsx|mjs|cjs|md|json|ndjson|yaml|yml|csv|tsv|py|png|jpe?g|webp|gif|svg|pptx|docx|pdf|xlsx|epub|dbk|mp4';

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

/**
 * Where a kickoff's work lands when the brief names no file: `index.html`
 * for a recognizable browser build, a written document named after the
 * project for written work, and `null` for other making work ("fix the bug
 * in my backup script"), which names no file to gate on. Every goal used to
 * default to `index.html`, so a family trip was handed to a Developer as a
 * web page and a script fix got a web-page gate that could never pass.
 */
export function defaultDeliverableForBrief(input: {
  name: string;
  about: string;
  missionObjectives: string;
  taskDescription?: string;
}): { path: string; document: boolean } | null {
  const inferred = inferSourceDeliverablePath(input);
  if (inferred) return { path: inferred, document: false };
  if (!briefIsWrittenWork(input)) return null;
  return { path: documentDeliverablePath(input.name), document: true };
}

/**
 * A goal that names no file and asks for nothing to be built — "plan a
 * family trip", "summarize what I should know about heat pumps". A brief
 * with a making verb ("build the deliverable", "fix the script") keeps the
 * build kickoff even when it names no artifact.
 */
export function briefIsWrittenWork(input: {
  name: string;
  about: string;
  missionObjectives: string;
  taskDescription?: string;
}): boolean {
  if (macroLooksLikeBuildMission(input.name, input.about, input.missionObjectives)) return false;
  const text = `${input.name}\n${input.about}\n${input.taskDescription ?? ''}`;
  return !/\b(?:build|code|implement|develop|program|script|deploy|refactor|fix|debug|compile)\b/i.test(
    text,
  );
}

/** `family-trip-to-portugal.md` for "Family Trip to Portugal". */
export function documentDeliverablePath(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return `${slug || 'plan'}.md`;
}

/**
 * Who writes a document deliverable: a researcher for a question to look
 * into, a planner for something to organize, else a copywriter. A Developer
 * "building" a trip plan was the wrong person on the wrong verb.
 */
export function documentProducerRole(briefText: string): 'researcher' | 'planner' | 'copywriter' {
  if (/\b(?:research|investigate|look\s+into|find\s+out|compare|sources?)\b/i.test(briefText)) {
    return 'researcher';
  }
  if (
    /\b(?:plan|planning|itinerary|schedule|organi[sz]e|checklist|agenda|budget|timeline|trip|event)\b/i.test(
      briefText,
    )
  ) {
    return 'planner';
  }
  return 'copywriter';
}

/**
 * The one step a typed project's kickoff hands its lead. The type already
 * brought the lead's tools and an Output page, so the first draft is made
 * with those tools; the step finishes when the page's data file grows past
 * its seed, which is what the person will see.
 */
export function buildTypedKickoffStep(input: {
  typeName: string;
  brief: { name: string; about: string; taskDescription?: string };
  /** The person's own request, when it names this goal. Preferred over the meester's wording. */
  request?: string;
  dataFile?: string;
  /** Titles of parameters the brief left unsaid, filled with "soon". */
  unsaid: string[];
  /** Parameters read from the brief, already on the page. */
  known?: ReadonlyArray<{ title: string; value: string }>;
  /** The type's model-facing tools (its page-only tools excluded). */
  tools?: ReadonlyArray<{ name: string; description?: string }>;
}): { name: string; description: string } {
  const goal = input.request ?? input.brief.taskDescription ?? input.brief.about;
  const unsaid =
    input.unsaid.length > 0
      ? ` They have not said ${input.unsaid.map((t) => `"${t}"`).join(' or ')} yet; plan around it and ask for it in your reply.`
      : '';
  // A Reisleider handed a "record the trip's details" tool spent its first
  // turn re-recording Lisbon, four people and a date it made up for "next
  // spring", then asked a question; the board had no days (2026-10-12).
  const known =
    input.known && input.known.length > 0
      ? ` Already recorded from their words: ${input.known
          .map((k) => `"${k.title}" ${k.value}`)
          .join(', ')}. Start on the plan itself, not on recording those again.`
      : '';
  const where = input.dataFile
    ? ` The project's Output page shows \`${input.dataFile}\`, so make the first version there with this project's own tools; this step finishes when it has something in it.`
    : " Make the first version with this project's own tools.";
  // The page reads its data in the shape these tools write. A lead that wrote
  // trip.json by hand in a shape of its own left the trip board at "0 days".
  const tools =
    input.tools && input.tools.length > 0
      ? ` Your tools for it: ${input.tools
          .map((t) =>
            t.description ? `\`${t.name}\` (${t.description.replace(/\.$/, '')})` : `\`${t.name}\``,
          )
          .join(', ')}. Call one for each piece rather than writing the file yourself.`
      : '';
  return {
    name: 'First draft',
    description: `You lead this ${input.typeName} project for the person. Their goal: ${goal}${where}${tools}${known}${unsaid} Make what they asked for; if something more would help, offer it in your reply instead of adding it. Do the real work this turn rather than describing it. Then reply in two or three sentences: what you made, and the one thing you need from them next.`,
  };
}

/** "Build X" for a build, the goal's own name for everything else. */
export function kickoffTaskTitle(input: {
  name: string;
  about: string;
  missionObjectives: string;
}): string {
  return macroLooksLikeBuildMission(input.name, input.about, input.missionObjectives)
    ? `Build ${input.name}`
    : input.name;
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
