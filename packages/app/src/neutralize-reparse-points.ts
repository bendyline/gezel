/**
 * neutralize-reparse-points — install-time CLI the Windows NSIS hook runs
 * through the bundled node.exe immediately before each elevated recursive ACL
 * sweep (SanitizeDescendants in installer/nsis-hooks.nsh).
 *
 *   --root=<dir>   the tree about to be swept (required, absolute)
 *   --check        report unsafe links without removing anything
 *
 * Without --check, every link under the root that leads outside it, cannot be
 * resolved, or closes a traversal cycle is removed (the link, never its
 * target); links that stay inside are kept. One line is printed per removed or
 * unsafe link, then a summary. See reparse-sweep.ts for the rules.
 *
 * Exit codes:
 *   0 — the tree is safe to sweep
 *   1 — argument error, or the root itself cannot be swept safely
 *   2 — an unsafe link remains (check mode: any was found)
 *   3 — part of the tree could not be inspected, so it may hide one
 */
import { runReparseSweepCli } from './reparse-sweep.js';

process.exitCode = runReparseSweepCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
