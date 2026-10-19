/** A tiny, inert reading view. Model-authored HTML and action blocks never execute. */
export function appendReading(parent: HTMLElement, markdown: string): void {
  const source = markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '')
    .replace(/```(?:gezel-action|gezel-actions)[^\n]*\n[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\{\[[^\]]*\]\}/g, '');
  let code = false;
  let paragraph: string[] = [];
  const append = (tag: string, text: string) => {
    const element = document.createElement(tag);
    // Keep link labels readable without enabling arbitrary URLs in saved content.
    element.textContent = text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
    parent.append(element);
  };
  const flush = () => {
    if (paragraph.length) append(code ? 'pre' : 'p', paragraph.join(code ? '\n' : ' '));
    paragraph = [];
  };
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('```')) {
      flush();
      code = !code;
      continue;
    }
    if (code) {
      paragraph.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      append(`h${Math.min(heading[1]!.length + 1, 4)}`, heading[2]!);
    } else if (/^\s*[-*]\s+/.test(line)) {
      flush();
      append('p', `• ${line.replace(/^\s*[-*]\s+/, '')}`);
    } else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
}
