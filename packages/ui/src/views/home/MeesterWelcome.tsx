import {
  type FirstProject,
  type GezelSummary,
  type Poppetje as PoppetjeStruct,
  firstProjectsFor,
  interestArea,
} from '@bendyline/gezel';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { GezelIcon } from '../../components/GezelIcon.js';
import { InterestPicker } from '../../components/InterestPicker.js';
import { ReportErrorLink } from '../../components/ReportErrorLink.js';
import { queueComposerPrefill } from '../../components/composer-prefill.js';
import {
  downloadPercent,
  formatDownloadProgress,
  formatDownloadSize,
  formatDownloadTime,
  modelDisplay,
} from '../../components/first-run-model-text.js';
import {
  formatTimeLeft,
  installQuiet,
  steadyBytesPerSecond,
} from '../../components/install-rate.js';
import type { FirstRunModel } from '../../components/useFirstRunModel.js';
import { useInterests } from '../../components/useInterests.js';
import { useShowPoppetjes } from '../../components/useShowPoppetjes.js';
import { socialHost } from '../../components/useSocialMode.js';
import { runtimeCapabilities } from '../../runtime-capabilities.js';
import { openSettingsSection } from '../../settings-nav.js';
import { IntroHandboekArticle } from './IntroHandboekArticle.js';
import { MeesterFigure } from './MeesterFigure.js';
import { greetingForHour } from './utils.js';

/**
 * What the meester's conversation shows before the first message: the
 * meester, full-figure, introducing themselves.
 *
 * During first run it is also the whole of setup. The one thing the app
 * cannot do without, an AI model, is asked for in the meester's voice ("I
 * need my tools"), with one key; everything else first run used to ask
 * (security posture, display preferences) is a sensible default with one
 * muted line pointing at Settings. When the model lands the same surface
 * says "I'm ready", so the person never changes page.
 *
 * It asks for one thing at a time. Until the tools are on their way the
 * welcome is only that ask; what to make, the film and the helpers arrive
 * once the download is running, when there is time to read them.
 *
 * Nothing here is a model turn. It is static, so it is on screen before
 * anything can answer, and it never puts words in the meester's mouth that
 * they did not say.
 */

/** What first run still needs; null once a model can answer. */
export interface WelcomeSetup {
  /** The on-device download. `off` when the provider is a cloud one. */
  model: FirstRunModel;
  /** A phone host draws its own model list in place of the download key. */
  hostModels?: (opts: { setup: true }) => ReactNode;
}

/** The install-wide helpers made at boot, so no name on screen is a stranger. */
export interface WelcomeHelper {
  gezel: GezelSummary;
  does: string;
}

/**
 * Where the welcome is, for specs and the phone's smoke test: a phone's own
 * model list (`choose-model`), a cloud provider to connect (`connect`), the
 * download's own states, then `just-ready` and `ready`.
 */
function welcomeState(setup: WelcomeSetup | null, justReady: boolean): string {
  if (!setup) return justReady ? 'just-ready' : 'ready';
  if (setup.hostModels) return 'choose-model';
  return setup.model.state.kind === 'off' ? 'connect' : setup.model.state.kind;
}

/**
 * `asking`: the tools are still to be fetched, connected or retried, and the
 * welcome shows only that. `open`: everything else it has to say.
 */
type WelcomeStage = 'asking' | 'open';

/**
 * The stage a settled state calls for; null while the inventory is being
 * read. A check also runs between "downloading" and "ready", and the welcome
 * holds its stage through it rather than folding away under someone watching
 * the film.
 */
function settledWelcomeStage(setup: WelcomeSetup | null): WelcomeStage | null {
  if (!setup || setup.hostModels) return 'open';
  switch (setup.model.state.kind) {
    case 'needs-download':
    case 'off':
    case 'failed':
      return 'asking';
    case 'checking':
      return null;
    default:
      return 'open';
  }
}

/**
 * The tools are on their way, so a first request can be written now and
 * sent when they arrive. The composer holds it; see `sendWhenReady`.
 */
export function canQueueFirstRequest(setup: WelcomeSetup | null): boolean {
  if (!setup || setup.hostModels) return false;
  const { kind } = setup.model.state;
  return kind === 'installing' || kind === 'engine' || kind === 'ready';
}

const IDEAS_WHILE_FETCHING =
  "While tools are downloading, let's get ready for our first conversation. Here are some ideas for things I can help you with.";

/** A download that will take longer than this gets a line saying so. */
const SLOW_DOWNLOAD_SECONDS = 2 * 60 * 60;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "I'm Florian", or "I'm your meester" when names are hidden. */
function introduce(meesterName: string): string {
  const name = meesterName.trim();
  return name && name.toLowerCase() !== 'meester' && name.toLowerCase() !== 'your meester'
    ? `I'm ${name}`
    : `I'm your meester`;
}

export function MeesterWelcome({
  meesterName,
  meesterIcon,
  meesterPoppetje,
  meesterIconOverride,
  projectId,
  setup,
  justReady = false,
  helpers = [],
  onShown,
  onBrowseForYou,
}: {
  meesterName: string;
  meesterIcon?: string | null;
  meesterPoppetje?: PoppetjeStruct | null;
  meesterIconOverride?: boolean;
  projectId: string;
  /** First run: what the meester still needs before they can start. */
  setup?: WelcomeSetup | null;
  /** The model landed during this visit. */
  justReady?: boolean;
  helpers?: readonly WelcomeHelper[];
  /** The introduction is on screen. */
  onShown?: () => void;
  /** Open New Task on its For you shelf, for picks no first project serves. */
  onBrowseForYou?: () => void;
}) {
  useEffect(() => {
    onShown?.();
  }, [onShown]);
  const showPoppetjes = useShowPoppetjes();
  const [tourOpen, setTourOpen] = useState(false);
  const greeting = greetingForHour(new Date().getHours());
  const modelState = setup?.model.state.kind;
  const fetching = modelState === 'installing' || modelState === 'engine';
  const waitingForTools = Boolean(setup);
  const settledStage = settledWelcomeStage(setup ?? null);
  const heldStage = useRef<WelcomeStage>('asking');
  useEffect(() => {
    if (settledStage) heldStage.current = settledStage;
  }, [settledStage]);
  const askingForTools = (settledStage ?? heldStage.current) === 'asking';
  const interests = useInterests();
  // Latched for the visit: the first key pressed stamps the answer, and the
  // tray must not vanish under the person's finger.
  const [askingInterests, setAskingInterests] = useState(false);
  useEffect(() => {
    if (interests.ask) setAskingInterests(true);
  }, [interests.ask]);
  // The intro plays from the moment the tools are on their way, and is
  // latched for the visit, so the tools landing never pulls the video from
  // under someone watching it. Only the ask for tools holds it back. A phone
  // draws its own model list here and keeps its welcome as it was.
  const firstRun = waitingForTools && !setup?.hostModels;
  const [showIntro, setShowIntro] = useState(false);
  useEffect(() => {
    if (firstRun) setShowIntro(true);
  }, [firstRun]);
  // Send holds a request written now and sends it when the tools arrive.
  const canQueue = firstRun && !askingForTools;
  const capabilities = runtimeCapabilities();
  const firsts = firstProjectsFor({
    interests: interests.areas,
    canRunCraftbooks: capabilities.tasks && capabilities.chatTaskLaunch !== false,
    host: socialHost(),
  });
  // The question promises a start for what was picked. Until a first project
  // serves an area, New Task's For you shelf does: picking Data and Work used
  // to leave the same trip, language and party cards (2026-10-12).
  const served = new Set(firsts.map((first) => first.area));
  const unserved = interests.areas.filter((area) => !served.has(area));

  return (
    <div
      className="meester-welcome"
      data-testid="meester-welcome"
      data-welcome-state={welcomeState(setup ?? null, justReady)}
    >
      {showPoppetjes && (
        <div className="meester-welcome-figure">
          <MeesterFigure
            meesterName={meesterName}
            meesterPoppetje={meesterPoppetje ?? null}
            meesterIcon={meesterIcon ?? null}
            meesterIconOverride={meesterIconOverride === true}
            size={88}
          />
        </div>
      )}
      <div className="meester-welcome-body">
        <h2 className="meester-welcome-title">
          {greeting}. {introduce(meesterName)} — I run this workshop.
        </h2>

        {setup && <WelcomeTools setup={setup} />}

        {/* One thing at a time: while the tools are still to be asked for,
            the ask above is the whole welcome. Interests, first projects, the
            film and the helpers used to share the screen with it, and a new
            person met six things to read before the one to press. */}
        {!askingForTools && (
          <>
            {justReady && !setup && (
              <p className="meester-welcome-ready" aria-live="polite">
                I'm ready. What shall we make?
              </p>
            )}

            {askingInterests ? (
              <div className="meester-welcome-interests">
                <p className="meester-welcome-line">
                  {fetching
                    ? 'What would you like help with? Pick any.'
                    : 'What would you like help with? Pick any, and I will suggest a start.'}
                </p>
                <InterestPicker
                  label="What you would like help with"
                  selected={interests.areas}
                  onChange={(next) => void interests.save(next)}
                />
                <button
                  type="button"
                  className="gz-link-button meester-welcome-quiet-link"
                  onClick={() => {
                    if (interests.areas.length === 0) void interests.save([]);
                    setAskingInterests(false);
                  }}
                >
                  {interests.areas.length > 0 ? 'Done' : 'Not now'}
                </button>
              </div>
            ) : fetching ? (
              <p className="meester-welcome-line">{IDEAS_WHILE_FETCHING}</p>
            ) : (
              <p className="meester-welcome-line">
                Tell me what you want to get done. I'll get it started and tell you when it's ready.
                {/* The intro already plays further down; a second copy of it is noise. */}
                {!showIntro && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="gz-link-button meester-welcome-quiet-link"
                      aria-expanded={tourOpen}
                      onClick={() => setTourOpen((open) => !open)}
                    >
                      {tourOpen ? 'Hide the tour' : 'Take the 1-minute tour'}
                    </button>
                  </>
                )}
              </p>
            )}

            {tourOpen && !fetching && !showIntro && (
              <div className="meester-welcome-tour">
                <IntroHandboekArticle />
              </div>
            )}

            {/* Under the picker while it is up; once it is put away this same
                line moves up to lead the welcome, above the first projects. */}
            {askingInterests && fetching && (
              <p className="meester-welcome-line">{IDEAS_WHILE_FETCHING}</p>
            )}

            {/* First projects prefill the composer rather than sending, so the
                person makes the sentence theirs first. A typed one ends on a
                board the crew fills in; a craftbook one arrives with its book
                (and its sample) attached. See FIRST_PROJECTS and
                firstProjectsFor. */}
            <fieldset
              className="meester-welcome-openers gz-tray"
              aria-label="Something to start with"
            >
              {firsts.map((first) => (
                <button
                  key={first.id}
                  type="button"
                  className="gz-key gz-key--stacked meester-welcome-opener"
                  onClick={() => startFirstProject(projectId, first)}
                >
                  <span className="gz-key-label">{first.title}</span>
                  <span className="gz-key-hint">{first.hint}</span>
                </button>
              ))}
            </fieldset>
            {unserved.length > 0 && onBrowseForYou && (
              <p className="meester-welcome-alternatives">
                <button
                  type="button"
                  className="gz-link-button meester-welcome-quiet-link"
                  onClick={onBrowseForYou}
                >
                  {unserved.length === 1
                    ? `Browse plans for ${interestArea(unserved[0]!).label.toLowerCase()}`
                    : 'Browse plans for what you picked'}
                </button>
              </p>
            )}
            <p className="meester-welcome-alternatives">
              {canQueue
                ? "Write your first request below and press Send. I'll start on it the moment my tools arrive."
                : 'Or tell me in your own words, below.'}
            </p>

            {showIntro && (
              <section
                className="meester-welcome-intro"
                aria-labelledby="meester-welcome-intro-lead"
              >
                <p id="meester-welcome-intro-lead" className="meester-welcome-intro-lead">
                  {setup
                    ? 'While we wait, here is a bit more about Gezel:'
                    : 'Here is a bit more about Gezel:'}
                </p>
                <IntroHandboekArticle variant="player" />
              </section>
            )}

            {helpers.length > 0 && <WelcomeHelpers helpers={helpers} />}
          </>
        )}

        {waitingForTools && (
          <p className="meester-welcome-defaults">
            {setup?.model.state.kind === 'off'
              ? 'I only look in folders you share with me.'
              : 'Our conversations run on this computer, and I only look in folders you share with me.'}{' '}
            <button
              type="button"
              className="gz-link-button meester-welcome-quiet-link"
              onClick={() => openSettingsSection('securityCompliance')}
            >
              Change what I'm allowed to do
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

/** Put a first project's sentence in the composer, with its craftbook attached when it has one. */
function startFirstProject(projectId: string, first: FirstProject): void {
  if (first.kind === 'type') {
    queueComposerPrefill(projectId, first.prompt, undefined, { replace: true });
    return;
  }
  queueComposerPrefill(
    projectId,
    first.prompt,
    {
      origin: 'user',
      craftbookId: first.craftbookId,
      craftbookName: first.title,
      params: {},
      ...(first.sample
        ? { inputs: { [first.sample.param]: { from: 'sample', sampleId: first.sample.sampleId } } }
        : {}),
    },
    { replace: true },
  );
}

/**
 * A thread that already has messages when the model goes missing (a
 * Copilot sign-in lapsed, a model was deleted) keeps its history; the
 * meester's ask for tools sits at the bottom of it, above the composer.
 */
export function MeesterSetupNote({
  meesterName,
  meesterIcon,
  meesterPoppetje,
  meesterIconOverride,
  setup,
}: {
  meesterName: string;
  meesterIcon?: string | null;
  meesterPoppetje?: PoppetjeStruct | null;
  meesterIconOverride?: boolean;
  setup: WelcomeSetup;
}) {
  return (
    <div className="meester-setup-note" data-testid="meester-setup-note">
      <GezelIcon
        svg={meesterIcon ?? null}
        poppetje={meesterPoppetje ?? null}
        iconOverride={meesterIconOverride === true}
        name={meesterName}
        size={36}
      />
      <div className="meester-welcome-body">
        <WelcomeTools setup={setup} />
      </div>
    </div>
  );
}

function WelcomeHelpers({ helpers }: { helpers: readonly WelcomeHelper[] }) {
  const lead =
    helpers.length === 1
      ? 'One crew member already works here:'
      : 'Two crew members already work here:';
  return (
    <div className="meester-welcome-helpers">
      <p className="meester-welcome-helpers-lead">{lead}</p>
      <ul className="meester-welcome-helper-list">
        {helpers.map((helper) => (
          <li key={helper.gezel.id} className="meester-welcome-helper">
            <GezelIcon
              svg={helper.gezel.icon ?? null}
              poppetje={helper.gezel.poppetje ?? null}
              iconOverride={helper.gezel.iconOverride === true}
              name={helper.gezel.name}
              size={20}
            />
            <span>
              <strong>{helper.gezel.name}</strong> {helper.does}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Where setup stands, for the composer's "Can't send yet:" warning. Plain
 * status rather than the meester's voice, since it sits on the toolbar.
 */
export function composerWaitingStatus(setup: WelcomeSetup): string {
  if (setup.hostModels) return 'choose an AI model first';
  const { state } = setup.model;
  switch (state.kind) {
    case 'off':
      return 'connect an AI first';
    case 'checking':
      return 'looking for an AI model on this computer';
    case 'needs-download':
      return 'download tools (an AI model) first';
    case 'installing': {
      if (state.progress?.phase === 'verifying') return 'checking the AI model';
      if (state.progress?.phase === 'extracting-metadata') return 'unpacking the AI model';
      const pct = downloadPercent(state.progress);
      return pct === null ? 'downloading the AI model' : `downloading the AI model · ${pct}%`;
    }
    case 'engine': {
      if (state.error) return "the AI model couldn't be set up";
      const { progress } = state;
      const pct =
        progress && progress.totalBytes > 0
          ? Math.min(100, Math.round((progress.bytesWritten / progress.totalBytes) * 100))
          : null;
      return pct === null ? 'setting up the AI model' : `setting up the AI model · ${pct}%`;
    }
    case 'failed':
      return "the AI model didn't download";
    case 'ready':
      return 'getting ready';
  }
}

/** The tools beat: the one thing first run asks for, in the meester's voice. */
function WelcomeTools({ setup }: { setup: WelcomeSetup }) {
  if (setup.hostModels) {
    return (
      <div className="meester-welcome-tools">
        <p className="meester-welcome-line">
          Before we start, I need my tools: an AI model to think with. Pick one on this device or
          one to download.
        </p>
        {setup.hostModels({ setup: true })}
      </div>
    );
  }
  const { model } = setup;
  const { state } = model;
  if (state.kind === 'off') {
    return (
      <div className="meester-welcome-tools">
        <p className="meester-welcome-line">
          Before we start, I need my tools: an AI to think with. Connect one in Settings and I'll be
          ready.
        </p>
        <div className="meester-welcome-actions">
          <button
            type="button"
            className="meester-welcome-fetch"
            onClick={() => openSettingsSection('defaults')}
          >
            Connect an AI
          </button>
        </div>
      </div>
    );
  }
  if (state.kind === 'checking' || state.kind === 'ready') {
    return (
      <div className="meester-welcome-tools" aria-busy="true">
        <p className="meester-welcome-progress-label">
          <span className="first-run-banner-spinner" aria-hidden />
          {state.kind === 'ready'
            ? 'My tools are here. Getting ready…'
            : 'Let me see what is already on this computer…'}
        </p>
      </div>
    );
  }
  if (state.kind === 'needs-download') {
    // The model and the engine it runs on, which downloads beside it.
    const total = state.sizeBytes ? state.sizeBytes + (state.engineBytes ?? 0) : null;
    const onDisk = state.resumeBytes ?? 0;
    const resumed = total ? Math.min(onDisk, total) : onDisk;
    // The key says how much; how long depends on the connection, so that is
    // a sentence beneath it. A minute count on the key read as a promise, and
    // on a slow connection the promise was off by hours.
    const label = (
      resumed > 0
        ? [
            'Resume fetching my tools',
            ...(total ? [`${formatDownloadProgress(resumed, total)} done`] : []),
          ]
        : ['Fetch my tools', ...(total ? [formatDownloadSize(total)] : [])]
    ).join(' · ');
    const time = capitalize(formatDownloadTime(total ? total - resumed : null));
    return (
      <div className="meester-welcome-tools">
        <p className="meester-welcome-line">
          Before we start, I need my tools: an AI that runs privately on this computer. It's a
          one-time download.
        </p>
        <div className="meester-welcome-actions">
          <button
            type="button"
            className="meester-welcome-fetch"
            disabled={model.busy}
            title={`Downloads ${modelDisplay(state.modelId)}`}
            onClick={() => void model.start()}
          >
            {model.busy ? 'Starting…' : label}
          </button>
        </div>
        <p className="meester-welcome-progress-note">
          {time} on a fast connection, longer on a slow one. You can keep using this computer, and
          I'll pick up where I left off if it stops.
        </p>
        <AlternativeLinks model={model} alternatives={state.alternatives} />
      </div>
    );
  }
  if (state.kind === 'installing') {
    return (
      <div className="meester-welcome-tools">
        <FetchProgress model={model} />
      </div>
    );
  }
  if (state.kind === 'engine') {
    if (state.error) {
      return (
        <div className="meester-welcome-tools" role="alert">
          <p className="meester-welcome-line">
            My tools are here, but I couldn't set up the part that runs them on this computer.{' '}
            {state.error}
          </p>
          <div className="meester-welcome-actions">
            <button
              type="button"
              className="meester-welcome-fetch"
              onClick={() => model.retryEngine()}
            >
              Try again
            </button>
          </div>
          <p className="meester-welcome-alternatives">
            <ReportErrorLink
              className="gz-link-button meester-welcome-quiet-link"
              report={{
                surface: 'model-download',
                message: state.error,
                detail: { code: 'first-run-engine-failed', engine: state.provider },
              }}
            />
          </p>
        </div>
      );
    }
    const { progress } = state;
    const pct =
      progress && progress.totalBytes > 0
        ? Math.min(100, Math.round((progress.bytesWritten / progress.totalBytes) * 100))
        : null;
    return (
      <div className="meester-welcome-tools">
        <div className="meester-welcome-progress">
          <div
            className={
              pct !== null
                ? 'first-run-banner-bar meester-welcome-bar'
                : 'first-run-banner-bar first-run-banner-bar-indeterminate meester-welcome-bar'
            }
            aria-hidden
          >
            <div
              className="first-run-banner-bar-fill"
              style={pct !== null ? { width: `${pct}%` } : undefined}
            />
          </div>
          <p className="meester-welcome-progress-label">
            {pct !== null ? `Setting up my workbench · ${pct}%` : 'Setting up my workbench'}
          </p>
        </div>
      </div>
    );
  }
  // state.kind === 'failed'
  const isMismatch = state.mismatch != null;
  return (
    <div className="meester-welcome-tools" role="alert">
      <p className="meester-welcome-line">
        {isMismatch
          ? "My tools have changed on Hugging Face since this version of Gezel was made, so I can't vouch for the new copy. It is probably fine — models are often republished with small fixes."
          : `I couldn't fetch my tools. ${state.error}`}
      </p>
      <div className="meester-welcome-actions">
        {isMismatch && (
          <button
            type="button"
            className="meester-welcome-fetch"
            disabled={model.busy}
            onClick={() => void model.downloadAnyway()}
          >
            {model.busy ? 'Fetching…' : 'Fetch them anyway'}
          </button>
        )}
        <button
          type="button"
          className={isMismatch ? 'meester-welcome-secondary' : 'meester-welcome-fetch'}
          disabled={model.busy}
          onClick={() => void model.retry()}
        >
          {model.busy && !isMismatch ? 'Trying again…' : 'Try again'}
        </button>
      </div>
      <p className="meester-welcome-alternatives">
        {state.provider === 'mlx' && (
          <>
            <button
              type="button"
              className="gz-link-button meester-welcome-quiet-link"
              disabled={model.busy}
              title="Use the llama engine instead. Works without Python; slightly slower than MLX on Apple Silicon."
              onClick={() => void model.switchToLlamaCpp()}
            >
              Use the llama engine instead
            </button>
            {' · '}
          </>
        )}
        <button
          type="button"
          className="gz-link-button meester-welcome-quiet-link"
          disabled={model.busy}
          onClick={() => void model.switchToCopilot()}
        >
          {model.copilotAvailable === false
            ? 'Set up GitHub Copilot'
            : 'Use GitHub Copilot instead'}
        </button>
        {/* Not offered on a checksum mismatch: that is Hugging Face
            republishing a file, which the line above explains as expected.
            Last, because a report is what you do after the fixes fail. */}
        {!isMismatch && (
          <>
            {' · '}
            <ReportErrorLink
              className="gz-link-button meester-welcome-quiet-link"
              report={{
                surface: 'model-download',
                message: state.error,
                detail: { code: 'first-run-install-failed', engine: state.provider },
              }}
            />
          </>
        )}
      </p>
    </div>
  );
}

function AlternativeLinks({
  model,
  alternatives,
}: {
  model: FirstRunModel;
  alternatives: ReadonlyArray<{ id: string; name: string }>;
}) {
  const [showInstalled, setShowInstalled] = useState(false);
  return (
    <>
      <p className="meester-welcome-alternatives">
        {alternatives.length > 0 && (
          <>
            <button
              type="button"
              className="gz-link-button meester-welcome-quiet-link"
              aria-expanded={showInstalled}
              onClick={() => setShowInstalled((open) => !open)}
            >
              Use one already on this computer
            </button>
            {' · '}
          </>
        )}
        <button
          type="button"
          className="gz-link-button meester-welcome-quiet-link"
          onClick={() => openSettingsSection('defaults')}
        >
          Connect a cloud account instead
        </button>
      </p>
      {showInstalled && (
        <fieldset
          className="gz-tray meester-welcome-installed"
          aria-label="Models on this computer"
        >
          {alternatives.map((m) => (
            <button
              key={m.id}
              type="button"
              className="gz-key"
              disabled={model.busy}
              onClick={() => void model.pickInstalled(m.id)}
            >
              {m.name}
            </button>
          ))}
        </fieldset>
      )}
    </>
  );
}

/** One quiet line under the meester while the tools arrive. */
function FetchProgress({ model }: { model: FirstRunModel }) {
  const { state, rate, now } = model;
  // Not `model.busy`: the tap that started this download holds it until the
  // last byte, which would keep Pause disabled for the whole of it.
  const [pausing, setPausing] = useState(false);
  if (state.kind !== 'installing') return null;
  const { progress } = state;
  const pct = downloadPercent(progress);
  const downloading = progress?.phase === 'downloading';
  const parts = ['Fetching my tools'];
  let slow = false;
  if (progress?.phase === 'verifying') parts[0] = 'Checking my tools';
  else if (progress?.phase === 'extracting-metadata') parts[0] = 'Unpacking my tools';
  else if (progress && pct !== null) {
    // Amounts, not a percent: "8%" of an unknown whole says nothing about
    // how much is left to come.
    parts.push(formatDownloadProgress(progress.bytesWritten, progress.totalBytes));
    // No estimate, and no word about the connection, until the speed settles.
    const speed = steadyBytesPerSecond(rate);
    if (speed) {
      const remaining = progress.totalBytes - progress.bytesWritten;
      parts.push(formatTimeLeft(remaining, speed));
      slow = remaining / speed > SLOW_DOWNLOAD_SECONDS;
    }
  }
  const quiet = downloading ? installQuiet(rate, now) : 'moving';
  return (
    <div className="meester-welcome-progress">
      <div
        className={
          pct !== null
            ? 'first-run-banner-bar meester-welcome-bar'
            : 'first-run-banner-bar first-run-banner-bar-indeterminate meester-welcome-bar'
        }
        aria-hidden
      >
        <div
          className="first-run-banner-bar-fill"
          style={pct !== null ? { width: `${pct}%` } : undefined}
        />
      </div>
      <p className="meester-welcome-progress-label">
        <span>{parts.join(' · ')}</span>
        {downloading && (
          <button
            type="button"
            className="gz-link-button meester-welcome-quiet-link"
            disabled={pausing}
            onClick={() => {
              setPausing(true);
              void model.pause().finally(() => setPausing(false));
            }}
          >
            Pause
          </button>
        )}
      </p>
      {quiet === 'moving' && slow && (
        <p className="meester-welcome-progress-note">
          This connection is slow, so this will take a while. You can leave it running.
        </p>
      )}
      {quiet === 'quiet' && (
        <p className="meester-welcome-progress-note">
          Still coming — it arrives in large pieces, so this can pause for a while.
        </p>
      )}
      {quiet === 'stalled' && (
        <p className="meester-welcome-progress-note">
          Nothing has arrived for a few minutes. Check the internet connection; I'll pick up where I
          left off.
        </p>
      )}
    </div>
  );
}
