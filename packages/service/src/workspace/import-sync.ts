import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  type Craftbook,
  type DiscoveredInstruction,
  type DiscoveredSkill,
  type ImportProvenance,
  type InstructionSourceFile,
  type PendingPersona,
  type PendingScript,
  craftbookFromDoc,
  createLogger,
  formatCraftbookDocErrors,
  nowIso,
  parseSkillDoc,
  pickRandomNameWithGender,
  projectGezelId,
  skillToCraftbookDoc,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { ChatManager } from '../chat/manager.js';
import { safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import { pickRosterVoorman } from '../gezels/roster.js';
import { writeGeneratedScript } from '../scripts/install.js';
import { resolveInstructionAbout, sha256 } from './instruction-scanner.js';
import { translateShellBlock, triageShellBlock } from './skill-script-translator.js';

const log = createLogger('import-sync');

export interface ImportSyncDeps {
  store: Store;
  chat: ChatManager;
  home: string;
  /** Needed to instantiate a real voorman from the `voorman` gezel template. */
  catalog: CatalogService;
}

/** The gezel-template instantiated as a project's voorman when none can be promoted. */
const VOORMAN_TEMPLATE_ID = 'voorman';

export interface EnsureVoormanResult {
  /**
   * A freshly-minted voorman gezel, set only when {@link ensureProjectVoorman}
   * had to create one (no roster member to promote and no existing voorman to
   * reuse). Lets the HTTP creation path / index scan announce it on the global
   * SSE stream so the sidebar + Gezellen roster fold it in.
   */
  createdGezel?: { id: string; name: string };
}

/**
 * Idempotently reconcile a project's workspace conventions into the
 * project-local store:
 *
 *   1. The workspace-root instruction file (AGENTS.md/CLAUDE.md/copilot)
 *      → mirrored into the project's `about.md`, so the repo's own agent
 *      guidance flows into every scoped session's system prompt. (The
 *      canonical `@project` gezel that used to embody this is deprecated:
 *      see {@link syncProjectGezel} — we no longer mint new ones, only
 *      refresh those already on disk.)
 *   2. `.claude/skills` / `.gstack/skills` / `agents/skills` SKILL.md
 *      files → project-local craftbooks via the deterministic converter
 *      (`skillToCraftbookDoc`: preamble strip, `## Phase N` headings →
 *      gated steps, safe-subset shell → static TS — never the LLM in
 *      this lane). Conversions carrying scripts or a persona queue as
 *      *pending* proposals the user reviews before anything lands;
 *      prose-only books are written immediately.
 *
 * Hash-gated and provenance-tracked so it's cheap to call on every scan
 * and never clobbers a user's edits. Best-effort: failures are logged and
 * swallowed so a bad import never breaks indexing.
 */
export async function syncProjectImports(
  deps: ImportSyncDeps,
  projectId: string,
  instructions: DiscoveredInstruction[],
  skills: DiscoveredSkill[],
): Promise<void> {
  const { store } = deps;
  // Writes into an external workingDir need the user's opt-in; bail
  // quietly rather than throwing on every scan.
  const gate = await store.assertWorkspaceWritable(projectId).catch(() => null);
  if (!gate || !gate.ok) return;

  const prov = await store.readImportProvenance(projectId);
  let provChanged = false;

  provChanged = (await syncInstructionAbout(deps, projectId, instructions, prov)) || provChanged;
  provChanged = (await syncProjectGezel(deps, projectId, instructions, prov)) || provChanged;
  provChanged =
    (await syncSkillCraftbooks(deps, projectId, gate.workspaceDir, skills, prov)) || provChanged;

  if (provChanged) {
    await store.writeImportProvenance(projectId, prov).catch((err) => {
      log.warn(`[import-sync] ${projectId}: failed to persist provenance: ${describe(err)}`);
    });
  }
}

/**
 * Mirror the repo's instruction file into the project's `about.md`. This
 * is the canonical delivery path for AGENTS.md/CLAUDE.md content now that
 * the `@project` gezel is deprecated: `buildInstructions` injects
 * `project.about` into *every* scoped session's system prompt, so the
 * guidance reaches every gezel regardless of who the voorman is. Gated on
 * the merged-content hash so it rewrites only when the file changes, and
 * back-fills projects imported before this path existed.
 */
async function syncInstructionAbout(
  deps: ImportSyncDeps,
  projectId: string,
  instructions: DiscoveredInstruction[],
  prov: ImportProvenance,
): Promise<boolean> {
  const { store } = deps;
  // Reuse a previously-chosen file/mergeMode (gezel provenance or a prior
  // about merge) so a project that pinned CLAUDE.md doesn't flip to AGENTS.md.
  const mergeMode = prov.gezel?.mergeMode ?? 'primary';
  const preferred = prov.about?.sourceFile ?? prov.gezel?.sourceFile;
  const resolved = resolveInstructionAbout(instructions, mergeMode, preferred);
  if (!resolved) return false;
  if (prov.about?.hash === resolved.hash) return false; // unchanged since last merge

  await mergeInstructionIntoAbout(store, projectId, resolved).catch((err) =>
    log.warn(`[import-sync] ${projectId}: about-merge failed: ${describe(err)}`),
  );
  prov.about = { hash: resolved.hash, sourceFile: resolved.sourceFile };
  return true;
}

/**
 * Refresh an EXISTING canonical `@project` gezel's instruction-file
 * mapping. We no longer *mint* these — the concept is deprecated in favor
 * of `project.about` (see {@link syncInstructionAbout}) for context and a
 * real gezel (see {@link ensureProjectVoorman}) for the voorman. But
 * projects that already have one on disk keep working: the prompt is read
 * live from the file, so we only refresh the source mapping when the
 * winning file or its hash changes. Returns false (and does nothing) when
 * no `@project` gezel exists.
 */
async function syncProjectGezel(
  deps: ImportSyncDeps,
  projectId: string,
  instructions: DiscoveredInstruction[],
  prov: ImportProvenance,
): Promise<boolean> {
  const { store } = deps;
  const encodedId = projectGezelId(projectId);
  const existing = await store.getGezel(encodedId).catch(() => null);
  if (!existing) return false; // deprecated — never mint a new one

  const mergeMode = prov.gezel?.mergeMode ?? 'primary';
  const resolved = resolveInstructionAbout(instructions, mergeMode, prov.gezel?.sourceFile);
  if (!resolved) return false;

  // Identity edits are protected by `userEdited` (set by the UI) — but the
  // about is always file-driven, so nothing is clobbered here.
  const sourceChanged = prov.gezel?.sourceFile !== resolved.sourceFile;
  const hashChanged = prov.gezel?.hash !== resolved.hash;
  if (!sourceChanged && !hashChanged) return false;

  await store.writeProjectLocalConfig(projectId, {
    schemaVersion: 1,
    sourceFile: resolved.sourceFile as InstructionSourceFile,
    mergeMode,
    aboutHash: resolved.hash,
    derivedAt: nowIso(),
  });
  prov.gezel = {
    ...(prov.gezel ?? { gezelId: encodedId }),
    hash: resolved.hash,
    sourceFile: resolved.sourceFile as InstructionSourceFile,
    mergeMode,
    gezelId: encodedId,
  };
  return true;
}

const ABOUT_BLOCK_START = '<!-- gezel:instructions:start -->';
const ABOUT_BLOCK_END = '<!-- gezel:instructions:end -->';

/**
 * Insert or refresh a machine-managed block in the project's `about.md`
 * holding the repo's instruction-file content. Everything outside the
 * delimiters (the README-derived About the user may have edited by hand)
 * is preserved, so this is safe to re-run. about.md lives under app-data,
 * not the workspace, so it writes even for read-only external checkouts.
 */
async function mergeInstructionIntoAbout(
  store: Store,
  projectId: string,
  resolved: { content: string; sourceFile: string; hash: string },
): Promise<void> {
  const detail = await store.getProject(projectId).catch(() => null);
  const current = detail?.about ?? '';
  const block = [
    ABOUT_BLOCK_START,
    `## Agent instructions (imported from ${resolved.sourceFile})`,
    '',
    resolved.content.trim(),
    ABOUT_BLOCK_END,
  ].join('\n');

  let next: string;
  const startIdx = current.indexOf(ABOUT_BLOCK_START);
  if (startIdx >= 0) {
    const endMarker = current.indexOf(ABOUT_BLOCK_END, startIdx);
    const endIdx = endMarker >= 0 ? endMarker + ABOUT_BLOCK_END.length : current.length;
    next = `${current.slice(0, startIdx)}${block}${current.slice(endIdx)}`;
  } else {
    const head = current.trim();
    next = head.length > 0 ? `${head}\n\n${block}\n` : `${block}\n`;
  }
  if (next !== current) {
    await store.updateProject(projectId, { about: next });
  }
}

/**
 * Make sure a project ends up with a voorman. This is the forward path now
 * that the `@project` gezel is deprecated: prefer promoting an existing
 * project-member gezel; if there's no one to promote, recruit a real
 * global gezel from the `voorman` template (the same instantiation
 * `start_project` uses). Runs at most once — the `voormanAutoAssignedAt`
 * marker stops a later *manual* clear from being silently re-populated on
 * the next scan. Store-side only (project metadata + a global gezel), so
 * it's safe even when the workspace isn't writable. Best-effort — never
 * throws.
 */
export async function ensureProjectVoorman(
  deps: ImportSyncDeps,
  projectId: string,
): Promise<EnsureVoormanResult> {
  const { store, catalog } = deps;
  if (!projectId || projectId === 'default') return {};
  const project = await store.getProject(projectId).catch(() => null);
  if (!project) return {};
  if (project.voormanAutoAssignedAt) return {}; // already ensured once — respect the user's choice

  // A voorman is already set (by the user, the Meester, or a project type
  // whose crew nominates one). Record that we've ensured one so a later
  // manual clear isn't fought on the next scan.
  if (project.voormanGezelId) {
    await store
      .updateProject(projectId, { voormanAutoAssignedAt: nowIso() })
      .catch((err) =>
        log.warn(`[import-sync] ${projectId}: voorman mark failed: ${describe(err)}`),
      );
    return {};
  }

  // 1. Promote an existing project-member gezel when there is one.
  const promote = await pickRosterVoorman(store, projectId).catch(() => null);
  if (promote) {
    await store
      .updateProject(projectId, { voormanGezelId: promote, voormanAutoAssignedAt: nowIso() })
      .then(() => log.info(`[import-sync] ${projectId}: promoted ${promote} to voorman`))
      .catch((err) =>
        log.warn(`[import-sync] ${projectId}: voorman promote failed: ${describe(err)}`),
      );
    return {};
  }

  // Solo projects (games, the chat room) never get a separate recruited
  // lead — the single roster gezel (the ambachtsman) IS the lead. If there
  // was nobody to promote above, leave the voorman unset rather than
  // minting a voorman-template gezel that shows up as a confusing second
  // "person" alongside the game's own gezel (the checkers Damspeler).
  if (project.mode === 'solo') return {};

  // 2. Reuse an existing voorman gezel from anywhere in the install rather
  // than minting a duplicate — one "Voorman" character can foreman several
  // blank projects (mirrors the leanProfile reuse pattern for solo types).
  const existing = await findExistingVoorman(store).catch(() => null);
  if (existing) {
    await store
      .updateProject(projectId, { voormanGezelId: existing, voormanAutoAssignedAt: nowIso() })
      .then(() => log.info(`[import-sync] ${projectId}: reused existing voorman ${existing}`))
      .catch((err) =>
        log.warn(`[import-sync] ${projectId}: voorman reuse failed: ${describe(err)}`),
      );
    return {};
  }

  // 3. Nobody to promote or reuse — recruit a fresh voorman from the template.
  const recruited = await recruitVoorman(store, catalog).catch((err) => {
    log.warn(`[import-sync] ${projectId}: voorman recruit failed: ${describe(err)}`);
    return null;
  });
  if (!recruited) return {}; // template missing / create failed — retry on a later scan
  await store
    .updateProject(projectId, { voormanGezelId: recruited.id, voormanAutoAssignedAt: nowIso() })
    .then(() => log.info(`[import-sync] ${projectId}: recruited ${recruited.id} as voorman`))
    .catch((err) =>
      log.warn(`[import-sync] ${projectId}: voorman assign failed: ${describe(err)}`),
    );
  return { createdGezel: recruited };
}

/**
 * Find an existing global gezel instantiated from the `voorman` template, so a
 * new project can reuse it instead of minting a duplicate foreman. Returns the
 * first match's id (stable listGezels ordering), or null when none exists yet.
 */
async function findExistingVoorman(store: Store): Promise<string | null> {
  const gezels = await store.listGezels().catch(() => []);
  const match = gezels.find((g) => g.templateId === VOORMAN_TEMPLATE_ID);
  return match?.id ?? null;
}

/**
 * Instantiate a fresh global gezel from the `voorman` template with a
 * randomly-drawn name/gender — mirrors `start_project`'s recruit step.
 * Returns the new gezel's id + name, or null when the template can't be resolved.
 */
async function recruitVoorman(
  store: Store,
  catalog: CatalogService,
): Promise<{ id: string; name: string } | null> {
  const detail = await catalog.get('gezel-template', VOORMAN_TEMPLATE_ID).catch(() => null);
  if (!detail || detail.manifest.kind !== 'gezel-template') return null;
  const { name, gender } = pickRandomNameWithGender();
  const created = await store.createGezel({
    name,
    role: detail.manifest.role,
    gender,
    about: detail.about ?? '',
    templateId: VOORMAN_TEMPLATE_ID,
    templateVersion: detail.manifest.version,
  });
  return { id: created.id, name: created.name };
}

/**
 * Convert discovered skills into project-local craftbooks. This is the
 * automatic lane, so it is STATIC-ONLY by policy: the deterministic
 * converter (headings→steps, safe-subset shell→TS) runs; the LLM
 * translator never does. Prose-only conversions write immediately;
 * anything carrying scripts or a persona queues in pending-imports —
 * the trust question is about the third-party source, not about who
 * authored the translation.
 */
async function syncSkillCraftbooks(
  deps: ImportSyncDeps,
  projectId: string,
  workspaceDir: string,
  skills: DiscoveredSkill[],
  prov: ImportProvenance,
): Promise<boolean> {
  const { store } = deps;
  let provChanged = false;
  const pending = await store.readPendingImports(projectId);
  let pendingChanged = false;

  for (const skill of skills) {
    const outcome = await convertDiscoveredSkill(deps, workspaceDir, skill, { allowLlm: false });
    if (!outcome) continue;

    const recorded = prov.craftbooks[skill.source];
    if (recorded?.hash === outcome.sourceHash) continue; // already imported, unchanged
    if (recorded?.userEdited) continue; // user owns it now — don't clobber
    // Already proposed and awaiting review at this exact hash? Leave the
    // proposal alone until the user acts on it.
    const pendingItem = pending.items.find((it) => it.skillSource === skill.source);
    if (pendingItem?.sourceHash === outcome.sourceHash) continue;

    if (outcome.scripts.length > 0 || outcome.persona) {
      pending.items = pending.items.filter((it) => it.skillSource !== skill.source);
      pending.items.push({
        skillSource: skill.source,
        sourceHash: outcome.sourceHash,
        craftbook: outcome.craftbook,
        scripts: outcome.scripts,
        ...(outcome.persona ? { persona: outcome.persona } : {}),
        ...(outcome.notes.length > 0 ? { notes: outcome.notes } : {}),
        createdAt: nowIso(),
      });
      pendingChanged = true;
      log.info(
        `[import-sync] ${projectId}: queued ${skill.source} for review (${outcome.scripts.length} script(s)${outcome.persona ? ', persona' : ''})`,
      );
    } else {
      await store.writeProjectCraftbook(projectId, outcome.craftbook).catch((err) => {
        log.warn(`[import-sync] ${projectId}: write craftbook failed: ${describe(err)}`);
      });
      prov.craftbooks[skill.source] = {
        hash: outcome.sourceHash,
        craftbookId: outcome.craftbook.id,
        scriptNames: [],
      };
      provChanged = true;
    }
  }

  if (pendingChanged) {
    await store.writePendingImports(projectId, pending).catch((err) => {
      log.warn(`[import-sync] ${projectId}: write pending failed: ${describe(err)}`);
    });
  }
  return provChanged;
}

export interface SkillConversionOutcome {
  craftbook: Craftbook;
  scripts: PendingScript[];
  persona?: PendingPersona;
  notes: string[];
  /** sha256 over the raw (unstripped) skill body + sorted companion paths. */
  sourceHash: string;
}

export interface ManualImportResult {
  status: 'written' | 'queued' | 'user-edited' | 'not-found' | 'failed';
  craftbookId?: string;
  scripts: number;
  persona?: string;
  notes: string[];
}

/**
 * The manual lane (`POST /imports/convert`, the `import_skill` MCP tool,
 * the CLI): convert ONE skill on demand. Unlike the indexer sync this
 * lane may use the LLM translator for simple-but-not-static shell blocks
 * — but script- or persona-bearing results still queue for approval
 * (model- and automation-initiated imports never write executable
 * content without consent). A `userEdited` book is never clobbered.
 */
export async function importDiscoveredSkill(
  deps: ImportSyncDeps,
  projectId: string,
  skillSource: string,
  opts: { allowLlm?: boolean } = {},
): Promise<ManualImportResult> {
  const { store } = deps;
  const gate = await store.assertWorkspaceWritable(projectId);
  if (!gate.ok)
    return { status: 'failed', scripts: 0, notes: [`workspace not writable: ${gate.reason}`] };

  const { discoverWorkspaceSkills } = await import('./skill-scanner.js');
  const skills = await discoverWorkspaceSkills(gate.workspaceDir);
  const skill = skills.find((s) => s.source === skillSource);
  if (!skill) return { status: 'not-found', scripts: 0, notes: [] };

  const prov = await store.readImportProvenance(projectId);
  if (prov.craftbooks[skill.source]?.userEdited) {
    return {
      status: 'user-edited',
      scripts: 0,
      notes: ['the imported book was edited by the user — not overwritten'],
    };
  }

  const outcome = await convertDiscoveredSkill(deps, gate.workspaceDir, skill, opts);
  if (!outcome)
    return { status: 'failed', scripts: 0, notes: ['conversion failed — see the service log'] };

  if (outcome.scripts.length > 0 || outcome.persona) {
    const pending = await store.readPendingImports(projectId);
    pending.items = pending.items.filter((it) => it.skillSource !== skill.source);
    pending.items.push({
      skillSource: skill.source,
      sourceHash: outcome.sourceHash,
      craftbook: outcome.craftbook,
      scripts: outcome.scripts,
      ...(outcome.persona ? { persona: outcome.persona } : {}),
      ...(outcome.notes.length > 0 ? { notes: outcome.notes } : {}),
      createdAt: nowIso(),
    });
    await store.writePendingImports(projectId, pending);
    return {
      status: 'queued',
      craftbookId: outcome.craftbook.id,
      scripts: outcome.scripts.length,
      ...(outcome.persona ? { persona: outcome.persona.role } : {}),
      notes: outcome.notes,
    };
  }

  await store.writeProjectCraftbook(projectId, outcome.craftbook);
  prov.craftbooks[skill.source] = {
    hash: outcome.sourceHash,
    craftbookId: outcome.craftbook.id,
    scriptNames: [],
  };
  await store.writeImportProvenance(projectId, prov);
  return {
    status: 'written',
    craftbookId: outcome.craftbook.id,
    scripts: 0,
    notes: outcome.notes,
  };
}

/**
 * Run the deterministic skill→craftbook converter against a discovered
 * skill, re-reading the SKILL.md from the workspace (the indexed
 * `skill.body` is preamble-stripped and capped — the converter wants
 * the raw text, and the provenance hash is defined over it). With
 * `allowLlm` (manual lanes only) simple-but-not-static shell blocks go
 * through the legacy LLM translator, wired onto the step that carried
 * them. Returns null when the source can't be read or the conversion
 * fails validation — both logged, never thrown (this runs on every
 * index pass).
 */
export async function convertDiscoveredSkill(
  deps: ImportSyncDeps,
  workspaceDir: string,
  skill: DiscoveredSkill,
  opts: { allowLlm?: boolean } = {},
): Promise<SkillConversionOutcome | null> {
  const sourceAbs = safeJoin(workspaceDir, skill.source);
  if (!sourceAbs) {
    log.warn(`[import-sync] ${skill.source}: path escapes the workspace — skipping`);
    return null;
  }
  const raw = await readFile(sourceAbs, 'utf8').catch((err: unknown) => {
    log.warn(`[import-sync] read ${skill.source} failed: ${describe(err)}`);
    return null;
  });
  if (raw === null) return null;

  const skillDoc = parseSkillDoc(raw.replace(/^﻿/, ''), {
    fallbackName: basename(dirname(skill.source)),
    files: skill.files ?? [],
  });
  const conversion = skillToCraftbookDoc(skillDoc, {
    idPrefix: 'proj-skill-',
    sourcePath: skill.source,
  });

  const pendingScripts: PendingScript[] = conversion.scripts.map((s) => ({
    name: s.name,
    body: s.body,
    confidence: 1,
    sourceBlock: s.sourceBlock,
    origin: 'static',
  }));

  if (opts.allowLlm) {
    for (const block of conversion.untranslated) {
      if (triageShellBlock(block.code) !== 'simple') continue;
      const name = `${conversion.doc.id ?? 'skill'}-llm-${pendingScripts.length + 1}`.replace(
        /^proj-skill-/,
        '',
      );
      const translated = await translateShellBlock(
        deps.chat,
        skillDoc.name,
        name,
        block.code,
      ).catch(() => null);
      if (!translated) continue;
      pendingScripts.push({
        name,
        body: translated.body,
        confidence: translated.confidence,
        sourceBlock: block.code,
        origin: 'llm',
      });
      conversion.doc.scripts = { ...(conversion.doc.scripts ?? {}), [name]: translated.body };
      const step = conversion.doc.steps.find((s) => s.id === block.stepId);
      if (step) {
        const refs = Array.isArray(step.onExit) ? step.onExit : step.onExit ? [step.onExit] : [];
        step.onExit = [
          ...refs,
          { name, scope: 'craftbook', autoAdvanceOnSuccess: false },
        ] as typeof step.onExit;
      }
    }
  }

  const runtime = craftbookFromDoc(conversion.doc, { now: nowIso() });
  if (!runtime.ok) {
    log.warn(
      `[import-sync] ${skill.source}: converted doc failed validation:\n${formatCraftbookDocErrors(runtime.errors)}`,
    );
    return null;
  }

  const filesKey = (skillDoc.files ?? []).map((f) => f.relPath).join('\n');
  return {
    craftbook: runtime.craftbook,
    scripts: pendingScripts,
    ...(conversion.persona ? { persona: conversion.persona } : {}),
    notes: conversion.notes,
    sourceHash: sha256(`${skillDoc.rawBody}\u0000${filesKey}`),
  };
}

/**
 * Approve a pending import: persist the craftbook (inline scripts ride
 * with it — `writeProjectCraftbook` lays them down as `scripts/*.ts`),
 * mint the persona gezel when one was proposed, and promote provenance.
 * Approval is the user's consent moment for both scripts and personas.
 * Legacy items whose scripts weren't inline still write via
 * `writeGeneratedScript`. Returns the approved craftbook id, or null
 * when no pending item matched.
 */
export async function approvePendingImport(
  deps: ImportSyncDeps,
  projectId: string,
  skillSource: string,
): Promise<string | null> {
  const { store, home } = deps;
  const pending = await store.readPendingImports(projectId);
  const item = pending.items.find((it) => it.skillSource === skillSource);
  if (!item) return null;

  const inlineNames = new Set(Object.keys(item.craftbook.scripts ?? {}));
  const scriptNames: string[] = [];
  for (const script of item.scripts) {
    scriptNames.push(script.name);
    if (inlineNames.has(script.name)) continue; // rides inline on the book
    await writeGeneratedScript(
      home,
      projectId,
      script.name,
      script.body,
      `${item.skillSource}#${item.sourceHash}`,
    );
  }
  await store.writeProjectCraftbook(projectId, item.craftbook);

  if (item.persona) {
    await ensurePersonaGezel(deps, projectId, item.persona).catch((err) => {
      log.warn(`[import-sync] ${projectId}: persona mint failed: ${describe(err)}`);
    });
  }

  const prov = await store.readImportProvenance(projectId);
  prov.craftbooks[skillSource] = {
    hash: item.sourceHash,
    craftbookId: item.craftbook.id,
    scriptNames,
  };
  await store.writeImportProvenance(projectId, prov);

  pending.items = pending.items.filter((it) => it.skillSource !== skillSource);
  await store.writePendingImports(projectId, pending);
  return item.craftbook.id;
}

/**
 * Make the approved persona real: reuse a project member with the same
 * role when one exists; else reuse a global gezel with the role (adding
 * it to the project); else create a fresh gezel from the persona's
 * about and add it. Mirrors the voorman-recruit shape.
 */
async function ensurePersonaGezel(
  deps: ImportSyncDeps,
  projectId: string,
  persona: PendingPersona,
): Promise<void> {
  const { store } = deps;
  const wanted = persona.role.trim().toLowerCase();

  // Membership is the project's gezelIds roster (not the project-local
  // gezel dir) — resolve each member's role before deciding to recruit.
  const project = await store.getProject(projectId).catch(() => null);
  for (const memberId of project?.gezelIds ?? []) {
    const member = await store.getGezel(memberId).catch(() => null);
    if ((member?.role ?? '').trim().toLowerCase() === wanted) return;
  }

  const all = await store.listGezels().catch(() => []);
  const existing = all.find((g) => (g.role ?? '').trim().toLowerCase() === wanted);
  if (existing) {
    await store.addGezelToProject(projectId, existing.id, { source: 'manual' });
    log.info(`[import-sync] ${projectId}: persona "${persona.role}" → existing ${existing.id}`);
    return;
  }

  const { name, gender } = pickRandomNameWithGender();
  const created = await store.createGezel({
    name,
    role: persona.role,
    gender,
    about: persona.about,
  });
  await store.addGezelToProject(projectId, created.id, { source: 'manual' });
  log.info(`[import-sync] ${projectId}: persona "${persona.role}" → recruited ${created.id}`);
}

/**
 * Reject a pending import: drop the generated scripts (inline map and
 * step wiring) and skip the persona; write the craftbook prose-only so
 * the skill is still usable.
 */
export async function rejectPendingImport(
  deps: ImportSyncDeps,
  projectId: string,
  skillSource: string,
): Promise<string | null> {
  const { store } = deps;
  const pending = await store.readPendingImports(projectId);
  const item = pending.items.find((it) => it.skillSource === skillSource);
  if (!item) return null;

  // Strip the script wiring → prose-only craftbook.
  const proseBook: Craftbook = {
    ...item.craftbook,
    steps: item.craftbook.steps.map((s) => {
      const { onExit, ...rest } = s;
      void onExit;
      return rest;
    }),
  };
  delete proseBook.scripts;
  delete proseBook.hooks;
  await store.writeProjectCraftbook(projectId, proseBook);

  const prov = await store.readImportProvenance(projectId);
  prov.craftbooks[skillSource] = {
    hash: item.sourceHash,
    craftbookId: proseBook.id,
    scriptNames: [],
  };
  await store.writeImportProvenance(projectId, prov);

  pending.items = pending.items.filter((it) => it.skillSource !== skillSource);
  await store.writePendingImports(projectId, pending);
  return proseBook.id;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
