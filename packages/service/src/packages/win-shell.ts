/**
 * cmd.exe quoting for `spawn(..., { shell: true })` on Windows.
 *
 * Node does not escape anything when `shell: true` — it concatenates the
 * command and every argument with spaces and hands the result to
 * `cmd.exe /d /s /c`. That is what Node's own DEP0190 deprecation warns
 * about. Two consequences bite in practice:
 *
 *  1. **The command is a token too.** A `.cmd`/`.bat` shim under a path
 *     with a space — `C:\Program Files\nodejs\claude.cmd`, which is
 *     exactly where `npm i -g` puts one — gets split at the space, and
 *     cmd reports `'C:\Program' is not recognized`. Quoting only the
 *     arguments does not help; several call sites did that and still
 *     broke.
 *  2. **Quoting is not optional for safety.** Inside double quotes cmd
 *     treats `&`, `|`, `<`, `>`, `^`, `(`, `)` as literal, so a semver
 *     caret or a spec like `foo & calc.exe` survives instead of
 *     injecting a command.
 *
 * `%` is the exception that cannot be escaped: variable expansion fires
 * even inside double quotes. Control characters are never valid in a
 * path or a package spec. Both are rejected rather than mangled — a
 * caller that cannot be quoted safely must not be run through a shell at
 * all.
 *
 * Prefer avoiding the shell entirely. This exists for the cases that
 * genuinely need it: Windows `.cmd`/`.bat` shims cannot be exec'd
 * directly (spawn returns EINVAL since the Node 18.20+ CVE mitigation).
 */

export class UnquotableShellTokenError extends Error {
  constructor(token: string) {
    super(`cannot safely quote for the Windows shell: ${JSON.stringify(token)}`);
    this.name = 'UnquotableShellTokenError';
  }
}

/**
 * Quote one token (command path or argument) for cmd.exe. Always quotes
 * rather than quoting conditionally: a bare token is only safe until
 * someone's install path grows a space, and this is not a hot path.
 *
 * @throws {UnquotableShellTokenError} when the token contains `%` or a
 * control character.
 */
export function quoteWinShellToken(token: string): string {
  for (let i = 0; i < token.length; i++) {
    if (token.charCodeAt(i) < 0x20 || token[i] === '%') {
      throw new UnquotableShellTokenError(token);
    }
  }
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Prepare a command + argv pair for `spawn`. Returns them unchanged when
 * no shell is involved — on that path Node passes argv straight to
 * CreateProcess, where quoting would be taken literally and become part
 * of the value.
 *
 * Use at every `shell: true` spawn site so command and arguments cannot
 * drift apart again; quoting one without the other is the bug this
 * module exists to prevent.
 */
export function winShellSafe(
  command: string,
  args: readonly string[],
  shell: boolean,
): { command: string; args: string[] } {
  if (!shell) return { command, args: [...args] };
  return {
    command: quoteWinShellToken(command),
    args: args.map(quoteWinShellToken),
  };
}
