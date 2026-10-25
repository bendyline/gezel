/**
 * The last sentence of a tool result that tells the model what to say to the
 * person. Without it the model repeated what the result handed it: a bakery
 * owner read "task default/2", "Formatted Report" and `invoices.json` in a
 * reply about their invoices.
 */
export const PLAIN_WORDS_RELAY = "Use plain words; don't repeat task, project or craftbook ids.";
