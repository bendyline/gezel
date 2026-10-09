/** UTF-16 offsets in the original request, retained through spoken expansions. */
export interface KokoroSourceRange {
  readonly textStart: number;
  readonly textEnd: number;
}

export class MappedSpeechText {
  constructor(
    readonly text: string,
    readonly ranges: readonly KokoroSourceRange[],
  ) {}

  static from(text: string, normalize = true): MappedSpeechText {
    let output = '';
    const ranges: KokoroSourceRange[] = [];
    for (const { segment, index } of new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    }).segment(text)) {
      const normalized = normalize ? segment.normalize('NFC') : segment;
      output += normalized;
      for (let i = 0; i < normalized.length; i++) {
        ranges.push({ textStart: index, textEnd: index + segment.length });
      }
    }
    return new MappedSpeechText(output, ranges);
  }

  range(start: number, end: number): KokoroSourceRange {
    return { textStart: this.ranges[start]!.textStart, textEnd: this.ranges[end - 1]!.textEnd };
  }

  replace(
    pattern: RegExp,
    replacement: string | ((match: string, ...captures: string[]) => string),
  ): MappedSpeechText {
    let output = '';
    const ranges: KokoroSourceRange[] = [];
    let cursor = 0;
    const appendOriginal = (start: number, end: number) => {
      output += this.text.slice(start, end);
      for (let i = start; i < end; i++) ranges.push(this.ranges[i]!);
    };
    for (const match of this.text.matchAll(pattern)) {
      appendOriginal(cursor, match.index);
      const changed =
        typeof replacement === 'string' ? replacement : replacement(match[0], ...match.slice(1));
      if (changed === match[0]) appendOriginal(match.index, match.index + match[0].length);
      else {
        output += changed;
        const range = this.range(match.index, match.index + match[0].length);
        for (let i = 0; i < changed.length; i++) ranges.push(range);
      }
      cursor = match.index + match[0].length;
    }
    appendOriginal(cursor, this.text.length);
    return new MappedSpeechText(output, ranges);
  }

  trim(): MappedSpeechText {
    const start = this.text.length - this.text.trimStart().length;
    const end = this.text.trimEnd().length;
    return new MappedSpeechText(this.text.slice(start, end), this.ranges.slice(start, end));
  }
}
