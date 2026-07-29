/**
 * pin-revisions — backfill the `revision` (commit SHA) pin onto every
 * chat-model manifest's `mlx` / `llamaCpp` source block.
 *
 * Why: downloads resolve from `huggingface.co/<repo>/resolve/<rev>/…`.
 * Without a pinned revision we fetch from the moving `main` tip, so an
 * upstream re-publish (model authors routinely tweak chat templates /
 * tokenizer configs) changes the bytes out from under our pinned
 * sha256s → install fails with a checksum mismatch. Pinning the commit
 * freezes the exact snapshot the sha256s were computed against.
 *
 * Conservative by design: for each source we resolve the repo's current
 * `main` commit, fetch the tree at that commit, and compare every
 * pinned file's sha256 to the tree. Only when ALL match do we write the
 * revision (a safe freeze of what we already ship). If anything has
 * DRIFTED — a sha differs, or a pinned file no longer exists — we leave
 * the manifest untouched and report it: that model needs a human to
 * re-pin AND re-test (an upstream template change can alter behavior;
 * see the "No user query found" template bug).
 *
 * Usage:
 *   tsx scripts/pin-revisions.ts            # dry run, report only
 *   tsx scripts/pin-revisions.ts --write    # apply to clean manifests
 *   tsx scripts/pin-revisions.ts --write --filter gemma   # subset by id
 *   tsx scripts/pin-revisions.ts --write --force          # re-pin even
 *                                                          # if revision set
 *   tsx scripts/pin-revisions.ts --adopt --filter gemma   # ADOPT latest
 *     upstream for drifted blocks (recompute sha+size, pin revision);
 *     skips versioned manifests unless --include-versions. Add --write
 *     to apply. Re-test adopted models — content changed upstream.
 *
 * Edits are surgical text insertions (a `revision` line after each
 * `huggingfaceRepo` line) so diffs stay one line per source block; the
 * result is JSON-parse-validated before writing.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchHuggingfaceCommit, fetchHuggingfaceTree } from '../src/hf-api.js';
import { requireGildeCheckout } from './gilde-checkout.js';

/**
 * SHA-256 a single file at a pinned revision by downloading it. Used
 * only for small non-LFS files (configs, chat templates), where the HF
 * tree API exposes the git-blob SHA-1 — not comparable to the SHA-256
 * our manifests store. LFS files (weights) expose `lfs.oid` (a real
 * sha256) in the tree, so those never need a download.
 */
async function sha256AtRevision(repo: string, revision: string, path: string): Promise<string> {
  const url = `https://huggingface.co/${repo}/resolve/${revision}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}?download=true`;
  // Retry transient network blips (ECONNRESET, fetch failed) — HF
  // occasionally drops a connection mid-handshake.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${path} @ ${revision.slice(0, 10)}: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return createHash('sha256').update(buf).digest('hex');
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const DATA_DIR = join(requireGildeCheckout().dataDir, 'chat-models');

/** Recursively collect every `manifest.json` under `dir`. */
function findManifests(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findManifests(full));
    else if (entry.name === 'manifest.json') out.push(full);
  }
  return out;
}

/**
 * Human label for a manifest path. Versioned copies live at
 * `<id>/versions/<v>/manifest.json` and don't carry a top-level `id`,
 * so derive `<id>@<version>` from the path; the top-level current
 * manifest is just `<id>`.
 */
function labelForPath(path: string, manifestId: string): string {
  const m = path.match(/chat-models\/[^/]+\/([^/]+)\/versions\/([^/]+)\/manifest\.json$/);
  if (m) return `${m[1]}@${m[2]}`;
  return manifestId;
}

interface PinnedFile {
  path: string;
  sha256: string;
}

interface SourceBlock {
  key: 'mlx' | 'llamaCpp' | 'ds4';
  repo: string;
  revision?: string;
  files: PinnedFile[];
}

/** Pull the pinned (path, sha256) list out of an mlx / llamaCpp / ds4 block.
 *  ds4's install payload is shaped exactly like llamaCpp's. */
function pinnedFiles(key: SourceBlock['key'], src: Record<string, unknown>): PinnedFile[] {
  const out: PinnedFile[] = [];
  if (key === 'mlx') {
    for (const f of (src.files as Array<{ name: string; sha256: string }>) ?? []) {
      out.push({ path: f.name, sha256: f.sha256 });
    }
    return out;
  }
  // llamaCpp / ds4: single file, or shards[], plus optional sidecars.
  if (typeof src.filename === 'string' && typeof src.sha256 === 'string') {
    out.push({ path: src.filename, sha256: src.sha256 });
  }
  for (const s of (src.shards as Array<{ name: string; sha256: string }>) ?? []) {
    out.push({ path: s.name, sha256: s.sha256 });
  }
  const mmproj = src.mmproj as { filename: string; sha256: string } | undefined;
  if (mmproj) out.push({ path: mmproj.filename, sha256: mmproj.sha256 });
  const draftModel = src.draftModel as { filename: string; sha256: string } | undefined;
  if (draftModel) out.push({ path: draftModel.filename, sha256: draftModel.sha256 });
  return out;
}

function readSources(manifest: Record<string, unknown>): SourceBlock[] {
  const out: SourceBlock[] = [];
  for (const key of ['mlx', 'llamaCpp', 'ds4'] as const) {
    const src = manifest[key] as Record<string, unknown> | undefined;
    if (!src || typeof src.huggingfaceRepo !== 'string') continue;
    out.push({
      key,
      repo: src.huggingfaceRepo,
      revision: typeof src.revision === 'string' ? src.revision : undefined,
      files: pinnedFiles(key, src),
    });
  }
  return out;
}

/**
 * Adopt a new sha + size for one pinned file: replace the (unique) old
 * sha256 string, then update the size field that immediately follows it
 * (`sizeBytes` for mlx files / shards / sidecars, `approxSizeBytes` for a
 * single-file llamaCpp source). Returns the new text, or throws if the
 * old sha isn't found exactly once (so a bad edit fails loud, never
 * silently corrupts).
 */
function adoptFileEdit(text: string, oldSha: string, newSha: string, newSize: number): string {
  if (oldSha === newSha) {
    // sha unchanged (e.g. only size drifted) — update size anchored on it.
    return text.replace(
      new RegExp(`("${oldSha}",\\s*"(?:sizeBytes|approxSizeBytes)":\\s*)\\d+`),
      `$1${newSize}`,
    );
  }
  const occurrences = text.split(`"${oldSha}"`).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly 1 occurrence of sha ${oldSha.slice(0, 10)}, found ${occurrences}`,
    );
  }
  let next = text.replace(`"${oldSha}"`, `"${newSha}"`);
  next = next.replace(
    new RegExp(`("${newSha}",\\s*"(?:sizeBytes|approxSizeBytes)":\\s*)\\d+`),
    `$1${newSize}`,
  );
  return next;
}

/**
 * Insert or replace `"revision": "<commit>"` right after the
 * `huggingfaceRepo` line carrying `<repo>`. Conservative pin mode leaves
 * an existing revision alone; adopt mode replaces it so refreshed hashes
 * and sizes are pinned to the snapshot they were read from.
 */
function upsertRevision(
  text: string,
  repo: string,
  commit: string,
  replaceExisting = false,
): string | null {
  const lines = text.split('\n');
  // Escape regex metachars in the repo id (dots, dashes are common).
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\s*)"huggingfaceRepo":\\s*"${escaped}"(,?)\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = line.match(re);
    if (!m) continue;
    const indent = m[1] ?? '';
    const hadComma = m[2] === ',';
    const nextLine = lines[i + 1] ?? '';
    const existingRevision = nextLine.match(/^(\s*)"revision":\s*"[0-9a-f]+"(,?)\s*$/);
    if (existingRevision) {
      if (!replaceExisting) return null;
      const existingIndent = existingRevision[1] ?? indent;
      const existingComma = existingRevision[2] ?? '';
      const replacement = `${existingIndent}"revision": "${commit}"${existingComma}`;
      if (replacement === nextLine) return null;
      lines[i + 1] = replacement;
      return lines.join('\n');
    }
    // huggingfaceRepo must end with a comma so the inserted line is
    // valid; if it was the last key, add one and drop it from revision.
    if (!hadComma) lines[i] = `${line.replace(/\s*$/, '')},`;
    const revLine = `${indent}"revision": "${commit}"${hadComma ? ',' : ''}`;
    lines.splice(i + 1, 0, revLine);
    return lines.join('\n');
  }
  return null;
}

type TreeEntry = { sha256: string; lfsBacked: boolean; sizeBytes: number };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const force = args.includes('--force');
  // Adopt mode: for DRIFTED source blocks, recompute sha256 + size from
  // the current `main` and rewrite them (then pin the revision). This
  // intentionally ADOPTS upstream changes — use only after deciding the
  // new content is acceptable (re-test the model; an upstream template
  // change can alter behavior). Implies --write. Skips versioned
  // (`versions/<v>`) manifests unless --include-versions is passed, so
  // historical releases aren't silently rewritten to current content.
  const adopt = args.includes('--adopt');
  const includeVersions = args.includes('--include-versions');
  const filterIdx = args.indexOf('--filter');
  const filter = filterIdx >= 0 ? args[filterIdx + 1] : undefined;

  const files = findManifests(DATA_DIR).sort();

  // Cache per-repo work so models sharing a repo don't re-fetch.
  const commitCache = new Map<string, string>();
  const treeCache = new Map<string, Map<string, TreeEntry>>();
  const nonLfsShaCache = new Map<string, string>(); // `${repo}@${commit}:${path}` → sha256

  const resolveRepo = async (
    repo: string,
  ): Promise<{ commit: string; tree: Map<string, TreeEntry> }> => {
    let commit = commitCache.get(repo);
    if (!commit) {
      commit = await fetchHuggingfaceCommit(repo, { rev: 'main' });
      commitCache.set(repo, commit);
    }
    let tree = treeCache.get(repo);
    if (!tree) {
      const entries = await fetchHuggingfaceTree(repo, { rev: commit });
      tree = new Map(
        entries.map((e) => [
          e.path,
          { sha256: e.sha256, lfsBacked: e.lfsBacked, sizeBytes: e.sizeBytes },
        ]),
      );
      treeCache.set(repo, tree);
    }
    return { commit, tree };
  };

  // Authoritative sha256 of a pinned file at a commit: lfs.oid for LFS
  // weights (free, from the tree); download + hash for small non-LFS
  // files (the tree only exposes their git-blob SHA-1).
  const fileSha = async (
    repo: string,
    commit: string,
    entry: TreeEntry,
    path: string,
  ): Promise<string> => {
    if (entry.lfsBacked) return entry.sha256;
    const key = `${repo}@${commit}:${path}`;
    const cached = nonLfsShaCache.get(key);
    if (cached) return cached;
    const sha = await sha256AtRevision(repo, commit, path);
    nonLfsShaCache.set(key, sha);
    return sha;
  };

  let pinned = 0;
  let alreadyPinned = 0;
  let drifted = 0;
  let skipped = 0;
  let adopted = 0;
  let repinned = 0;
  const driftReport: string[] = [];
  const adoptReport: string[] = [];

  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const manifest = JSON.parse(text) as Record<string, unknown>;
    const id = labelForPath(path, String(manifest.id ?? '<unknown>'));
    if (filter && !id.includes(filter)) continue;
    const sources = readSources(manifest);
    if (sources.length === 0) {
      skipped++;
      continue;
    }

    // ── Adopt mode ──────────────────────────────────────────────────
    if (adopt) {
      const isVersioned = /\/versions\//.test(path);
      if (isVersioned && !includeVersions) {
        continue; // protect historical releases
      }
      let newText = text;
      let changed = false;
      let contentChanged = false;
      let failed = false;
      for (const src of sources) {
        let commit: string;
        let tree: Map<string, TreeEntry>;
        try {
          ({ commit, tree } = await resolveRepo(src.repo));
        } catch (err) {
          adoptReport.push(
            `  ${id} [${src.key}] ${src.repo}: HF lookup failed — ${err instanceof Error ? err.message : err}`,
          );
          failed = true;
          continue;
        }
        for (const f of src.files) {
          const entry = tree.get(f.path);
          if (!entry) {
            adoptReport.push(
              `  ${id} [${src.key}]: ${f.path} no longer exists upstream — manual fix needed`,
            );
            failed = true;
            continue;
          }
          let newSha: string;
          try {
            newSha = await fileSha(src.repo, commit, entry, f.path);
          } catch (err) {
            adoptReport.push(
              `  ${id} [${src.key}]: ${f.path} hash failed — ${err instanceof Error ? err.message : err}`,
            );
            failed = true;
            continue;
          }
          if (newSha === f.sha256) continue; // this file unchanged
          try {
            newText = adoptFileEdit(newText, f.sha256, newSha, entry.sizeBytes);
            changed = true;
            contentChanged = true;
            adoptReport.push(
              `  ${id} [${src.key}]: ${f.path} → ${newSha.slice(0, 10)} (${entry.sizeBytes} B)`,
            );
          } catch (err) {
            adoptReport.push(
              `  ${id} [${src.key}]: ${f.path} edit failed — ${err instanceof Error ? err.message : err}`,
            );
            failed = true;
          }
        }
        // Pin the revision too (covers both the just-adopted block and
        // any block that was already content-clean but still unpinned).
        const next = upsertRevision(newText, src.repo, commit, true);
        if (next) {
          newText = next;
          changed = true;
        }
      }
      if (failed || !changed) continue;
      // Validate + re-verify: the rewritten manifest must parse AND every
      // pinned sha must now match the pinned commit. This guards the
      // surgical text edits — a bad replace fails here, never on disk.
      let reManifest: Record<string, unknown>;
      try {
        reManifest = JSON.parse(newText) as Record<string, unknown>;
      } catch {
        adoptReport.push(`  ${id}: adopt produced invalid JSON — SKIPPED`);
        continue;
      }
      let verifyOk = true;
      for (const src of readSources(reManifest)) {
        if (!src.revision) {
          verifyOk = false;
          break;
        }
        const tree = treeCache.get(src.repo);
        if (!tree) continue;
        for (const f of src.files) {
          const entry = tree.get(f.path);
          if (!entry) {
            verifyOk = false;
            break;
          }
          let actual: string;
          try {
            actual = await fileSha(src.repo, src.revision, entry, f.path);
          } catch {
            verifyOk = false;
            break;
          }
          if (actual.toLowerCase() !== f.sha256.toLowerCase()) {
            verifyOk = false;
            break;
          }
        }
      }
      if (!verifyOk) {
        adoptReport.push(`  ${id}: post-adopt verification FAILED — not written`);
        continue;
      }
      if (contentChanged) {
        adopted++;
        console.log(`${write ? 'adopted ' : 'would adopt '} ${id}`);
      } else {
        repinned++;
        console.log(`${write ? 'repinned' : 'would repin'} ${id} (files unchanged)`);
      }
      if (write) writeFileSync(path, newText);
      continue;
    }
    // ── Conservative pin mode (default) ─────────────────────────────

    let newText = text;
    let fileDrifted = false;
    const toInsert: Array<{ repo: string; commit: string }> = [];

    for (const src of sources) {
      if (src.revision && !force) {
        alreadyPinned++;
        continue;
      }
      let commit: string;
      let tree: Map<string, TreeEntry>;
      try {
        ({ commit, tree } = await resolveRepo(src.repo));
      } catch (err) {
        fileDrifted = true;
        driftReport.push(
          `  ${id} [${src.key}] ${src.repo}: HF lookup failed — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      // Conservative gate: every pinned file must still match the
      // snapshot at `commit`. LFS files compare by `lfs.oid` (a sha256,
      // free); non-LFS files (small configs/templates) only expose a
      // git-blob SHA-1 in the tree, so we download + sha256 them to
      // compare against the manifest's sha256.
      const mismatches: string[] = [];
      for (const f of src.files) {
        const entry = tree.get(f.path);
        if (entry === undefined) {
          mismatches.push(`${f.path} (gone)`);
          continue;
        }
        let actual: string;
        try {
          actual = await fileSha(src.repo, commit, entry, f.path);
        } catch (err) {
          mismatches.push(`${f.path} (hash failed: ${err instanceof Error ? err.message : err})`);
          continue;
        }
        if (actual.toLowerCase() !== f.sha256.toLowerCase()) {
          mismatches.push(`${f.path} (sha changed)`);
        }
      }
      if (mismatches.length > 0) {
        fileDrifted = true;
        driftReport.push(
          `  ${id} [${src.key}] ${src.repo} @ ${commit.slice(0, 10)}: ${mismatches.join(', ')}`,
        );
        continue;
      }
      toInsert.push({ repo: src.repo, commit });
    }

    if (fileDrifted) {
      drifted++;
      continue;
    }
    if (toInsert.length === 0) continue;

    for (const { repo, commit } of toInsert) {
      const next = upsertRevision(newText, repo, commit);
      if (next) newText = next;
    }
    // Validate: must still parse, and differ only by added revisions.
    try {
      JSON.parse(newText);
    } catch {
      driftReport.push(`  ${id}: text insertion produced invalid JSON — SKIPPED (report a bug)`);
      drifted++;
      continue;
    }
    pinned++;
    const tags = toInsert.map((t) => `${t.commit.slice(0, 10)}`).join(', ');
    console.log(`${write ? 'pinned ' : 'would pin '} ${id} → ${tags}`);
    if (write) writeFileSync(path, newText);
  }

  console.log('\n── summary ──');
  if (adopt) {
    console.log(`${write ? 'adopted' : 'would adopt'}: ${adopted}`);
    console.log(`${write ? 'repinned' : 'would repin'} (files unchanged): ${repinned}`);
    if (adoptReport.length > 0) {
      console.log('\nadopt detail:');
      for (const line of adoptReport) console.log(line);
    }
    if (adopted > 0) {
      console.log('\n⚠ adopted models pulled in current upstream content — re-test them.');
    }
  } else {
    console.log(`${write ? 'pinned' : 'would pin'}: ${pinned}`);
    console.log(`already pinned: ${alreadyPinned}`);
    console.log(`no source block: ${skipped}`);
    console.log(`drifted (needs manual re-pin + re-test): ${drifted}`);
    if (driftReport.length > 0) {
      console.log('\ndrift detail:');
      for (const line of driftReport) console.log(line);
    }
  }
  if (!write && (pinned > 0 || adopted > 0 || repinned > 0)) {
    console.log('\n(dry run — re-run with --write to apply)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
