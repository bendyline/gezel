import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LicenseButton } from './LicenseButton.js';

describe('LicenseButton', () => {
  it('labels an open license and links to its URL', () => {
    render(
      <LicenseButton
        manifest={{
          license: 'Apache 2.0',
          licenseClass: 'open',
          licenseShortName: 'Apache 2.0',
          licenseUrl:
            'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/blob/main/LICENSE.md',
          commercialUse: true,
        }}
      />,
    );
    const link = screen.getByRole('link', { name: /Free, open \(Apache 2\.0\)/ });
    expect(link).toHaveAttribute(
      'href',
      'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/blob/main/LICENSE.md',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.className).toContain('license-button--open');
  });

  it('labels a non-commercial license as a commercial restriction', () => {
    render(
      <LicenseButton
        manifest={{
          license: 'Krea 2 Community License',
          licenseClass: 'commercial-restricted',
          licenseShortName: 'Krea 2 Community',
          licenseUrl: 'https://huggingface.co/krea/Krea-2-Turbo/blob/main/LICENSE.pdf',
          commercialUse: false,
        }}
      />,
    );
    const link = screen.getByRole('link', {
      name: /Restrictions for commercial use \(Krea 2 Community\)/,
    });
    expect(link.className).toContain('license-button--commercial-restricted');
  });

  it('labels a use-restricted license as a custom restriction', () => {
    render(
      <LicenseButton
        manifest={{
          license: 'LTX-Video Open Weights (RAIL-M)',
          licenseClass: 'custom-restricted',
          licenseShortName: 'LTX Open Weights',
          licenseUrl: 'https://huggingface.co/Lightricks/LTX-2/blob/main/LICENSE',
          commercialUse: true,
        }}
      />,
    );
    expect(
      screen.getByRole('link', { name: /Custom restrictions \(LTX Open Weights\)/ }),
    ).toBeTruthy();
  });

  it('does NOT link to ollama.com by default — renders a static chip instead', () => {
    // Local-model pages (llama.cpp / MLX / image / video) must not send the
    // user to ollama.com. When the only link is an ollama.com upstream, the
    // badge falls back to a static chip.
    render(
      <LicenseButton
        manifest={{
          license: 'Apache-2.0',
          licenseClass: 'open',
          licenseShortName: 'Apache 2.0',
          upstream: 'https://ollama.com/library/gemma4',
        }}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/Free, open \(Apache 2\.0\)/)).toBeTruthy();
  });

  it('links to ollama.com upstream only when allowOllamaLink is set (Ollama tab)', () => {
    render(
      <LicenseButton
        allowOllamaLink
        manifest={{
          license: 'Apache-2.0',
          licenseClass: 'open',
          licenseShortName: 'Apache 2.0',
          upstream: 'https://ollama.com/library/gemma4',
        }}
      />,
    );
    const link = screen.getByRole('link', { name: /Free, open \(Apache 2\.0\)/ });
    expect(link).toHaveAttribute('href', 'https://ollama.com/library/gemma4');
  });

  it('links via a non-ollama upstream regardless of allowOllamaLink', () => {
    // The default only suppresses ollama.com — a HuggingFace upstream still links.
    render(
      <LicenseButton
        manifest={{
          license: 'Gemma Terms of Use',
          licenseClass: 'custom-restricted',
          licenseShortName: 'Gemma',
          upstream: 'https://huggingface.co/google/gemma-x',
        }}
      />,
    );
    const link = screen.getByRole('link', { name: /Custom restrictions \(Gemma\)/ });
    expect(link).toHaveAttribute('href', 'https://huggingface.co/google/gemma-x');
  });

  it('falls back to commercial-restricted from commercialUse when class is absent', () => {
    render(
      <LicenseButton
        manifest={{
          license: 'Some Non-Commercial License',
          upstream: 'https://huggingface.co/acme/model',
          commercialUse: false,
        }}
      />,
    );
    // No licenseClass/licenseShortName: prefix from commercialUse, name from `license`,
    // href falls back to the model card (`upstream`).
    const link = screen.getByRole('link', {
      name: /Restrictions for commercial use \(Some Non-Commercial License\)/,
    });
    expect(link).toHaveAttribute('href', 'https://huggingface.co/acme/model');
  });

  it('renders a static chip (not a link) when there is no URL or upstream', () => {
    render(
      <LicenseButton
        manifest={{
          license: 'Apache 2.0',
          licenseClass: 'open',
          licenseShortName: 'Apache 2.0',
          commercialUse: true,
        }}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/Free, open \(Apache 2\.0\)/)).toBeTruthy();
  });

  it('renders nothing when the model has no license metadata', () => {
    const { container } = render(<LicenseButton manifest={{ commercialUse: true }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
