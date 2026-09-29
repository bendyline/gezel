import { openHandboekArticleActions, runNavActions } from '../components/nav-actions.js';

/** Handboek article that explains what stays on the machine and what leaves it. */
export const PRIVACY_ARTICLE_ID = 'privacy-local-first';

const REPO_BLOB = 'https://github.com/bendyline/gezel/blob/main';

/**
 * The legal texts. They live in the repository (the EULA is the one the
 * installers show), and the daemon serves none of them, so they open on
 * GitHub. Installed apps also carry the third-party texts in their
 * `resources/licenses/` folder.
 */
export const LEGAL_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'License (MIT)', href: `${REPO_BLOB}/LICENSE` },
  { label: 'Third-party notices', href: `${REPO_BLOB}/NOTICE.md` },
  { label: 'End user license agreement', href: `${REPO_BLOB}/packages/app/EULA.txt` },
];

/** Settings → About → Legal and privacy. */
export function SettingsLegalSection() {
  return (
    <section className="settings-legal" style={{ marginBottom: '2rem' }}>
      <h3>Legal and privacy</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Gezel is free, open-source software. It also includes parts made by other people, each under
        its own license.
      </p>
      <ul className="settings-legal-links">
        <li>
          <button
            type="button"
            className="gz-link-button"
            onClick={() => runNavActions(openHandboekArticleActions(PRIVACY_ARTICLE_ID))}
          >
            How Gezel handles your data
          </button>{' '}
          <span className="muted small">in the Handboek</span>
        </li>
        {LEGAL_LINKS.map((link) => (
          <li key={link.href}>
            <a href={link.href} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          </li>
        ))}
      </ul>
      <p className="muted small">The license, notices, and agreement open on GitHub.</p>
    </section>
  );
}
