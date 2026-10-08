// Allow dots and colons to support real-world Ollama tag names like
// `llama3.2` or `qwen2.5:7b`. Length cap keeps filesystem paths sane.
export const IdRegex = /^[a-z0-9][a-z0-9.\-:]{1,63}$/;
