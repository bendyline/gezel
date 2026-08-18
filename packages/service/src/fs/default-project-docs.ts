/**
 * Curated `about.md` / `missionObjectives.md` for the always-present
 * `default` project.
 *
 * The Default project is a grab bag by design — one-off questions, scratch
 * work, and small jobs that never grew into a project of their own. Without
 * these docs, every reviewer that walks the project list (the nightly
 * oversight run, a voorman on wake-up) rediscovers "Default has no about and
 * no mission objectives" and reports it as a gap, then judges the unrelated
 * items against each other. Stating the catch-all nature once, on disk, stops
 * that loop.
 *
 * Both are injected into system prompts for sessions scoped here (about for
 * everyone, mission for strategic owners only), so they stay short.
 */

export const DEFAULT_PROJECT_ABOUT_MD = `This is the catch-all project. Anything that does not belong to a dedicated project lands here: one-off questions, quick experiments, scratch work, and small jobs that never grew into a project of their own.

The contents are deliberately unrelated. Two items sitting side by side here usually have nothing to do with each other, and that is expected — there is no common thread to find, and the mix is not a sign that something needs reorganizing.

Judge work here item by item: is this artifact or task in good shape on its own terms? When something in here does grow into a real body of work, the right move is to propose a dedicated project for it rather than to give this one a theme.
`;

export const DEFAULT_PROJECT_MISSION_MD = `- Keep miscellaneous work moving: each item here should end up finished, deliberately parked, or promoted into a project of its own.
- Keep the artifacts in this project usable — accurate, current, and findable later.
- Do not pursue coherence between items. This project has no single theme and is not meant to acquire one.
`;

/**
 * Curated docs for the always-present `shared` project, whose workspace IS
 * the shared documents library.
 *
 * Same reasoning as the Default docs above, mirrored: a reviewer walking the
 * project list finds a project with no code, no build, and no tasks, and
 * would otherwise report that as neglect. Saying plainly that this project's
 * deliverable is the library itself stops that loop.
 */
export const SHARED_PROJECT_ABOUT_MD = `This project is the shared document library — the knowledge every gezel can reach, from any project. Mission statements, guidelines, policies, style guides, and reference material live here.

Its files are the deliverable. There is no code to build and no feature to ship: the work is keeping the library accurate, current, and findable. Documents here are owned by the user, so treat an existing document as theirs — improve it when asked, and never reorganize or rewrite it uninvited.

Knowledge that only matters to one project belongs in a folder named after that project; knowledge that applies everywhere belongs at the top level.
`;

/** Filename of the one document seeded into an empty library on first run. */
export const SHARED_LIBRARY_STARTER_DOC = 'About this library.md';

/**
 * Written once, only when the library is completely empty. It explains the
 * library to a first-run user and doubles as a worked example: the
 * frontmatter shows the title/description keys the listing surfaces.
 */
export const SHARED_LIBRARY_STARTER_MD = `---
title: About this library
description: What the shared document library is and how gezels use it.
---

# About this library

This is the shared document library. Everything filed here is readable by every gezel you work with, in every project — so it is the right home for the things that should be true everywhere: how you want writing to sound, what your team is trying to do, the rules a reviewer should apply, reference material worth keeping.

## How your gezels use it

Gezels see a listing of this library in every conversation, and they search its contents when a question touches team policy, guidelines, or conventions. You do not have to point them at a file: filing it here is enough.

Word, PDF, PowerPoint, and Excel documents work too. Drop one in and its text becomes searchable alongside your markdown.

## Filing suggestions

- Keep documents that apply everywhere at the top level.
- Put knowledge that only matters to one project in a folder named after it.
- A short, plain title beats a clever one — it is what a gezel sees first.

You can delete this document once the library has content of its own; nothing re-creates it.
`;

export const SHARED_PROJECT_MISSION_MD = `- Keep the library trustworthy: what it says should be true, current, and consistent with itself.
- Keep it findable — clear names, sensible folders, no duplicate answers to the same question in two places.
- Capture durable cross-project knowledge here rather than leaving it in a chat transcript.
- Do not add churn: this library is read far more often than it is written.
`;
