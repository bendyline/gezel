import { expect, it } from 'vitest';
import { AnswerText } from './answer-text.js';
it.each([
  ['<think>hidden</think>\nAnswer', 'Answer'],
  [' \n<think></think>  Answer', 'Answer'],
  ['<think>unfinished reasoning', ''],
  ['Literal <think> inside prose', 'Literal <think> inside prose'],
  ['<thi', '<thi'],
  ['Ordinary answer', 'Ordinary answer'],
])('filters only leading model reasoning: %s', (raw, expected) => {
  const filter = new AnswerText();
  let answer = '';
  for (const character of raw) answer += filter.push(character);
  expect(answer + filter.finish()).toBe(expected);
});
