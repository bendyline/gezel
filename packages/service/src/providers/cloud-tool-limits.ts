// Match the ordinary local tool-loop allowance. Twelve rounds can interrupt a
// healthy read/edit/validate sequence before it can hand off. The per-send
// deadline and this absolute cap still bound runaway cloud work.
export const CLOUD_TOOL_ROUND_LIMIT = 96;
