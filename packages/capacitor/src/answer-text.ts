/** Keep a model's leading thought block out of assistant content, even across token boundaries. */
export class AnswerText {
  private state: 'prefix' | 'thought' | 'leading' | 'answer' = 'prefix';
  private pending = '';
  push(text: string): string {
    if (this.state === 'prefix') {
      this.pending += text;
      const candidate = this.pending.trimStart();
      if (candidate.startsWith('<think>')) {
        this.pending = '';
        this.state = 'thought';
        return this.push(candidate.slice('<think>'.length));
      }
      if ('<think>'.startsWith(candidate) && this.pending.length < 256) return '';
      this.state = 'answer';
      const answer = this.pending;
      this.pending = '';
      return answer;
    }
    if (this.state === 'thought') {
      const combined = this.pending + text;
      const end = combined.indexOf('</think>');
      if (end === -1) {
        this.pending = combined.slice(-('</think>'.length - 1));
        return '';
      }
      this.pending = '';
      this.state = 'leading';
      return this.push(combined.slice(end + '</think>'.length));
    }
    if (this.state === 'leading') {
      const answer = text.trimStart();
      if (answer) this.state = 'answer';
      return answer;
    }
    return text;
  }
  finish(): string {
    const remaining = this.state === 'prefix' ? this.pending : '';
    this.pending = '';
    return remaining;
  }
}
