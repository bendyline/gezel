import { queueComposerPrefill } from '../../components/ChatComposer.js';
import { GezelIcon } from '../../components/GezelIcon.js';

/**
 * What the workshop shows before the first message.
 *
 * The conversation used to open as a blank panel: the product's whole pitch is
 * a crew of named companions, and a first-time user met an empty room with a
 * composer under it. Nothing here is a model turn — it is static, so it is
 * already on screen while a model is still downloading, and it never pretends
 * the meester said something they didn't.
 *
 * The openers prefill the composer rather than sending, so the user reads what
 * they are about to ask and can change it. They are deliberately about the
 * meester's actual job — sizing up work and assembling a crew — rather than
 * generic assistant prompts.
 */
const OPENERS = [
  'I want to start a project — can you help me work out what it needs?',
  'What kind of gezellen can you bring on, and what are they good at?',
  'Here is what I am working on today. Where should I start?',
] as const;

export function MeesterGreeting({
  meesterName,
  meesterIcon,
  meesterPoppetje,
  meesterIconOverride,
  projectId,
}: {
  meesterName: string;
  meesterIcon?: string | null;
  meesterPoppetje?: import('@bendyline/gezel').Poppetje | null;
  meesterIconOverride?: boolean;
  projectId: string;
}) {
  return (
    <div className="meester-greeting">
      <div className="meester-greeting-figure">
        <GezelIcon
          svg={meesterIcon ?? null}
          poppetje={meesterPoppetje ?? null}
          iconOverride={meesterIconOverride === true}
          name={meesterName}
          size={64}
        />
      </div>
      <div className="meester-greeting-body">
        <h3 className="meester-greeting-title">Hello — I'm {meesterName}, your meester.</h3>
        <p className="meester-greeting-lede">
          I'm the one you talk to first. Tell me what you're trying to get done and I'll work out
          which gezellen you need, bring them on, and set the project up around them. You can also
          just talk things through with me.
        </p>
        <fieldset className="meester-greeting-openers gz-tray" aria-label="Ways to start">
          {OPENERS.map((opener) => (
            <button
              key={opener}
              type="button"
              className="gz-key meester-greeting-opener"
              onClick={() => queueComposerPrefill(projectId, opener)}
            >
              {opener}
            </button>
          ))}
        </fieldset>
      </div>
    </div>
  );
}
