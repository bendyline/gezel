/**
 * Split a shell-flavored command line into tokens.
 *
 * Handles whitespace, single quotes, double quotes, and backslash
 * escapes inside double quotes. Single quotes are literal (no escape
 * processing inside them, matching POSIX `sh`). Outside quotes, a
 * backslash escapes the next character (so `\ ` → literal space).
 *
 * This is NOT a full shell parser — no variable expansion, no command
 * substitution, no globbing. The resolver passes the resulting argv
 * straight to `runWorkspaceCommand`, which spawns the child without a
 * shell on POSIX, so shell metacharacters like `*` or `$FOO` would
 * arrive at the binary literally anyway.
 *
 * Throws on unterminated quotes — callers should surface the error
 * to the user as a parse failure rather than running half a command.
 */
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < input.length) {
        const next = input[i + 1]!;
        // Inside double quotes, backslash only escapes a few chars.
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          buf += next;
          i++;
        } else {
          buf += ch;
        }
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      buf += input[i + 1];
      i++;
      hasToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (hasToken) {
        out.push(buf);
        buf = '';
        hasToken = false;
      }
      continue;
    }
    buf += ch;
    hasToken = true;
  }

  if (inSingle || inDouble) {
    throw new Error('Unterminated quoted string in command input');
  }
  if (hasToken) out.push(buf);
  return out;
}
