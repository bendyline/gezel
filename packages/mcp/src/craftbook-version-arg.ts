/*
 * ── Craftbook version argument ──────────────────────────────────────────
 *
 * `invoke_craftbook` publishes an optional `version` that defaults to the
 * latest. A deepseek-v4-flash Meester routing a Word-document request read
 * the `version: 1.0` line of the user's own document brief and passed it
 * here; no research-to-document version is "1.0", task creation threw
 * `craftbook "research-to-document" not found` twice, and the Meester then
 * hand-built the .docx outside the recipe (2026-09-29).
 *
 * The argument has a sane default, so it must not be able to fail the call:
 * a version the project cannot run is dropped, the latest runs, and the
 * caller is told. An exact pin the book does offer is still honoured, and an
 * empty version list (a listing that did not report one) passes the value
 * through unchanged so the service stays the judge.
 */
export function resolveCraftbookVersionArg(
  requested: string | undefined,
  availableVersions: readonly string[],
): { version?: string; ignored?: string } {
  const version = requested?.trim();
  if (!version) return {};
  if (availableVersions.length === 0 || availableVersions.includes(version)) return { version };
  return { ignored: version };
}
