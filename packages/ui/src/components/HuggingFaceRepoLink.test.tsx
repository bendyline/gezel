import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HuggingFaceRepoLink, huggingFaceRepoUrl } from './HuggingFaceRepoLink.js';

describe('HuggingFaceRepoLink', () => {
  it('links the repo id to its Hugging Face model card', () => {
    render(<HuggingFaceRepoLink repo="unsloth/gemma-4-12B-it-qat-GGUF" />);
    const link = screen.getByRole('link', { name: 'unsloth/gemma-4-12B-it-qat-GGUF' });
    expect(link).toHaveAttribute('href', 'https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('escapes each path segment rather than the slash between them', () => {
    // Repo ids are schema-constrained to URL-safe characters; a live-catalog
    // entry that slips through must not be able to steer the href elsewhere.
    expect(huggingFaceRepoUrl('acme/model?x=1')).toBe('https://huggingface.co/acme/model%3Fx%3D1');
  });
});
