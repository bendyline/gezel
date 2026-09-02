// Roles whose `[ref=eN]` is worth surfacing to a model trying to pick the
// next click/type target. Structural roles are deliberately excluded.
const INTERACTIVE_ROLES = [
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'spinbutton',
];

const ELEMENT_REF_RE = new RegExp(
  String.raw`^\s*- (` + INTERACTIVE_ROLES.join('|') + String.raw`)\s+"([^"]+)"\s+\[ref=(e\d+)\]`,
);

export interface PageElementMatch {
  role: string;
  name: string;
  ref: string;
}

/** Collect and de-duplicate interactive refs from a Playwright aria-tree YAML body. */
export function extractPageElementsFromYaml(yaml: string): PageElementMatch[] {
  const out: PageElementMatch[] = [];
  const seen = new Set<string>();
  for (const line of yaml.split('\n')) {
    const match = line.match(ELEMENT_REF_RE);
    if (!match) continue;
    const role = match[1];
    const name = match[2];
    const ref = match[3];
    if (!role || !name || !ref) continue;
    const key = `${ref}:${role}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, name, ref });
  }
  return out;
}

/** Score an element against a free-text description and optional exact role hint. */
export function scorePageElementMatch(
  element: PageElementMatch,
  description: string,
  role: string | undefined,
): number {
  const desc = description.toLowerCase().trim();
  const elementRole = element.role.toLowerCase();
  const elementName = element.name.toLowerCase();
  let score = 0;
  if (role && elementRole === role.toLowerCase()) score += 10;
  if (desc.length > 0 && elementName.includes(desc)) score += 5;
  if (desc.length > 0 && elementRole.includes(desc)) score += 1;
  for (const word of desc.split(/\s+/).filter(Boolean)) {
    if (elementName.includes(word) || elementRole.includes(word)) score += 1;
  }
  return score;
}
