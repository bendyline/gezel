/**
 * A reply that ends by asking the person to pick from options it wrote out
 * ("Which of these would you prefer?" over a numbered list), read as the
 * card `ask_user_question` would have posted. A gemma4-e2b Builder on the
 * Linux CLI ended its turn that way although its prompt said to use the
 * card; the person answered "3", and the next turn took it for the second
 * option (2026-11-02). A card sends the chosen option's words instead.
 */

export interface ProseChoiceQuestion {
  prompt: string;
  choices: string[];
}

// Top-level items only: a nested sub-point is detail, never an option.
const LIST_ITEM_RE = /^ ?(?:\d{1,2}[.)]|[-*•]|\(?[A-Fa-f]\))\s+(\S.*)$/;
// A question about the list, not any closing question: "Want me to change
// anything?" under a summary of finished work is not a choice.
const CHOICE_CUE_RE = /\b(?:which|prefer|choose|pick|options?|one of (?:these|those|them))\b/i;
const MIN_CHOICES = 2;
const MAX_CHOICES = 6;
const MAX_CHOICE_CHARS = 100;

function plain(text: string): string {
  return text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

/** The option's bold lead-in when it has one, else the option, kept short. */
function choiceLabel(item: string): string {
  const lead = item.match(/^\*\*(.+?)\*\*/)?.[1];
  const label = plain(lead ?? item).replace(/\s*[:.—-]+$/, '');
  if (label.length <= MAX_CHOICE_CHARS) return label;
  const cut = label.slice(0, MAX_CHOICE_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_CHOICE_CHARS / 2))}…`;
}

/** The last sentence of a line that ends in a question about the options. */
function choicePrompt(line: string | undefined): string | null {
  const text = plain(line ?? '');
  if (!text.endsWith('?')) return null;
  const question = text.split(/(?<=[.!?])\s+/).at(-1) ?? text;
  return CHOICE_CUE_RE.test(question) ? question : null;
}

/** The list items ending just above `end` (exclusive), skipping blank lines between them. */
function listAbove(lines: readonly string[], end: number): { items: string[]; start: number } {
  const items: string[] = [];
  let index = end - 1;
  while (index >= 0) {
    const line = lines[index] ?? '';
    const item = line.match(LIST_ITEM_RE)?.[1];
    if (item) items.unshift(item);
    else if (line.trim() !== '') break;
    index -= 1;
  }
  return { items, start: index };
}

function shaped(prompt: string | null, items: readonly string[]): ProseChoiceQuestion | null {
  if (!prompt || items.length < MIN_CHOICES || items.length > MAX_CHOICES) return null;
  const choices = items.map(choiceLabel);
  if (choices.some((choice) => !choice) || new Set(choices).size !== choices.length) return null;
  return { prompt, choices };
}

export function proseChoiceQuestion(content: string): ProseChoiceQuestion | null {
  if ((content.match(/```/g)?.length ?? 0) % 2 === 1) return null;
  const lines = content.trimEnd().split(/\r?\n/);
  const last = lines.length - 1;
  // "Which of these would you prefer?" then the options, ending the reply.
  const trailing = listAbove(lines, lines.length);
  if (trailing.items.length > 0) {
    let above = trailing.start;
    while (above >= 0 && (lines[above] ?? '').trim() === '') above -= 1;
    return shaped(choicePrompt(lines[above]), trailing.items);
  }
  // The options, then the question as the reply's last line.
  return shaped(choicePrompt(lines[last]), listAbove(lines, last).items);
}
