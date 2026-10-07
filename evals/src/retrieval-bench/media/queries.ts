/**
 * Off-topic prompts for the media bench: questions a person asks a gezel that
 * no photo, sound or video clip answers. A floor that lets one of these reach
 * a media row would put a random picture in front of them.
 */
export const MEDIA_ABSTAIN_QUERIES: readonly string[] = [
  'What is 17 times 23?',
  'How do I rotate a TLS certificate in nginx?',
  'Summarize the quarterly revenue figures for the board',
  'What does the error ENOENT mean in Node.js?',
  "Translate 'good morning' into Dutch",
  'Explain the difference between TCP and UDP',
  'Write a haiku about recursion',
  'What is the capital of Australia?',
  'How many days are left in the fiscal year?',
  'Refactor this function to use async/await',
  'What is the derivative of x squared?',
  'List the amendments to the US constitution',
  'How do I reset my password?',
  'What is a craftbook?',
  'Define the term amortization',
  'Convert 50 miles to kilometres',
  'Which TypeScript version added the satisfies operator?',
  'What are the terms of the Apache 2.0 license?',
  'Schedule a meeting for Tuesday at 3pm',
  'Explain how a hash map works',
];

/** ESC-50 class name → the query a person would type for it. */
export function esc50Query(category: string): string {
  return `the sound of ${category.replace(/_/g, ' ')}`;
}
