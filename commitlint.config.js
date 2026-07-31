/**
 * Conventional Commits, minus the length policing.
 *
 * config-conventional caps the header and every body/footer line at 100
 * characters. Our bodies are prose paragraphs, not hand-wrapped columns —
 * enforcing a per-line ceiling on them only turns a descriptive message into a
 * CI failure, and reflowing after the fact means rewriting pushed history. The
 * structural rules are the ones that carry weight: `multi-semantic-release`
 * derives every published version bump from the type and subject, so those
 * stay enforced.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-case': [0],
    'header-max-length': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
