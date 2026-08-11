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
