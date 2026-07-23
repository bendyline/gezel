/**
 * Quote + signature stripping for message bodies. Per the project decision,
 * each stored message is ONLY what that sender wrote — quoted reply history and
 * signatures are dropped entirely (full context is reconstructable from the
 * sibling messages in the thread folder). This keeps per-message chunks clean
 * so a long thread doesn't N-times-duplicate its own text and wreck FTS/vector
 * relevance.
 *
 * Heuristic and intentionally aggressive: it truncates at the first reply
 * attribution / quote block / forwarded header / signature delimiter it finds.
 */

/** A line that begins a quoted-reply / forwarded section. */
function isQuoteBoundary(line: string, next: string | undefined): boolean {
  const l = line.trimEnd();
  // Gmail/Apple-style attribution: "On <date>, <person> wrote:" (may wrap, so
  // also match a bare "... wrote:" tail and an opening "On ... " line).
  if (/\bwrote:\s*$/.test(l)) return true;
  if (/^On\b.{0,200}$/.test(l) && next !== undefined && /\bwrote:\s*$/.test(next.trimEnd())) {
    return true;
  }
  // Quoted text (one or more leading '>').
  if (/^\s*>/.test(line)) return true;
  // Outlook / generic "Original Message" separators.
  if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(l)) return true;
  if (/^\s*-{2,}\s*Forwarded message\s*-{2,}/i.test(l)) return true;
  // Outlook horizontal divider before the quoted header block.
  if (/^_{10,}\s*$/.test(l)) return true;
  // Outlook forwarded header: "From: ..." immediately followed by Sent/Date/To.
  if (/^\s*From:\s/i.test(l) && next !== undefined && /^\s*(Sent|Date|To|Subject):/i.test(next)) {
    return true;
  }
  return false;
}

/** A line that begins a signature block (RFC 3676 `-- `, or common variants). */
function isSignatureBoundary(line: string): boolean {
  const l = line.trimEnd();
  if (l === '--' || l === '-- ') return true;
  if (/^Sent from my (iPhone|iPad|Android|mobile|Samsung)/i.test(l)) return true;
  if (/^Get Outlook for (iOS|Android)/i.test(l)) return true;
  return false;
}

/**
 * Return the body with quoted history and signature removed. Operates on a
 * plain-text or markdown body (markdown blockquotes also use `>` so the same
 * quote rule catches converted HTML replies).
 */
export function stripQuotedAndSignature(body: string): string {
  const lines = body.split(/\r?\n/);
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isQuoteBoundary(line, lines[i + 1]) || isSignatureBoundary(line)) {
      cut = i;
      break;
    }
  }
  return lines
    .slice(0, cut)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
