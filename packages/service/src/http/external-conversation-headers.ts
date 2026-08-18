/**
 * Opt-in provenance headers for caller-owned chat loops.
 *
 * A stable conversation id is the minimum required to mirror an external
 * transcript into Gezel. The directory and project are optional routing hints;
 * the recorder falls back to the default project when neither resolves to one
 * unambiguous project.
 */
export const EXTERNAL_CONVERSATION_ID_HEADER = 'x-gezel-external-conversation-id';
export const EXTERNAL_WORKING_DIRECTORY_HEADER = 'x-gezel-working-directory';
export const EXTERNAL_PROJECT_HEADER = 'x-gezel-project';
