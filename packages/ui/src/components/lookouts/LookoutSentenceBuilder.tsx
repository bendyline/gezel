import type {
  Lookout,
  LookoutAction,
  LookoutCondition,
  LookoutInput,
  LookoutSoundClip,
} from '@bendyline/gezel';
import { type KeyboardEvent, useState } from 'react';
import { Select } from '../../primitives/index.js';
import { onRadioKeyDown } from '../../primitives/radio-keyboard.js';
import './lookouts.css';

export interface LookoutChoices {
  cameras: Array<{ id: string; name: string }>;
  /** Website connections a lookout can follow. */
  websites: Array<{ id: string; name: string }>;
  mailAccounts: Array<{ id: string; name: string }>;
  gezels: Array<{ id: string; name: string }>;
  craftbooks: Array<{ id: string; name: string }>;
}

type WatchFor = 'motion' | 'person' | 'pet' | 'specific';

const WATCH_FOR: Array<{ id: WatchFor; label: string }> = [
  { id: 'motion', label: 'Anything moving' },
  { id: 'person', label: 'A person' },
  { id: 'pet', label: 'A pet' },
  { id: 'specific', label: 'Something specific' },
];

type PageWatch = 'page-changed' | 'page-added' | 'text-appears';

const PAGE_WATCH: Array<{ id: PageWatch; label: string }> = [
  { id: 'page-changed', label: 'A page that changed' },
  { id: 'page-added', label: 'A new page' },
  { id: 'text-appears', label: 'Words that appear' },
];

const CLIPS: Array<{ id: LookoutSoundClip; label: string }> = [
  { id: 'chime', label: 'Chime' },
  { id: 'alarm', label: 'Alarm' },
  { id: 'whistle', label: 'Whistle' },
];

function watchForOf(condition: LookoutCondition | undefined): WatchFor {
  if (!condition) return 'specific';
  if (condition.kind === 'motion') return 'motion';
  if (condition.kind === 'subject') return condition.subjects.includes('person') ? 'person' : 'pet';
  return 'specific';
}

interface Draft {
  name: string;
  /** What the lookout follows: a camera or a website connection. */
  sourceKind: 'camera' | 'website';
  /** The binding id of that camera or website. */
  cameraId: string;
  watchFor: WatchFor;
  pageWatch: PageWatch;
  words: string;
  pathPrefix: string;
  question: string;
  sure: boolean;
  notify: boolean;
  sound: LookoutSoundClip | null;
  speak: string | null;
  push: boolean;
  email: { bindingId: string; recipients: string } | null;
  askGezel: { gezelId: string; instruction: string } | null;
  craftbook: string | null;
  cooldownMinutes: number;
  maxPerDay: number;
  hours: { from: string; to: string } | null;
}

function draftFrom(lookout: Lookout | undefined, choices: LookoutChoices): Draft {
  const actions = lookout?.actions ?? [];
  const find = <K extends LookoutAction['kind']>(kind: K) =>
    actions.find((a) => a.kind === kind) as Extract<LookoutAction, { kind: K }> | undefined;
  const email = find('email');
  const ask = find('ask-gezel');
  const c = lookout?.condition;
  const sourceKind: Draft['sourceKind'] =
    lookout?.source.kind ?? (choices.cameras.length > 0 ? 'camera' : 'website');
  return {
    name: lookout?.name ?? '',
    sourceKind,
    cameraId:
      lookout?.source.bindingId ??
      (sourceKind === 'camera' ? choices.cameras[0]?.id : choices.websites[0]?.id) ??
      '',
    watchFor: watchForOf(lookout?.condition),
    pageWatch: c?.kind === 'page-added' || c?.kind === 'text-appears' ? c.kind : 'page-changed',
    words: c?.kind === 'text-appears' ? c.text : '',
    pathPrefix:
      c && (c.kind === 'page-changed' || c.kind === 'page-added' || c.kind === 'text-appears')
        ? (c.pathPrefix ?? '')
        : '',
    question: lookout?.condition.kind === 'ask' ? lookout.condition.question : '',
    sure: lookout?.condition.kind === 'ask' ? lookout.condition.strictness === 'sure' : false,
    notify: lookout ? Boolean(find('notify')) : true,
    sound: find('sound')?.clip ?? (lookout ? null : 'chime'),
    speak: find('speak')?.text ?? null,
    push: Boolean(find('push')),
    email: email ? { bindingId: email.bindingId, recipients: email.recipients.join(', ') } : null,
    askGezel: ask ? { gezelId: ask.gezelId ?? '', instruction: ask.instruction } : null,
    craftbook: find('run-craftbook')?.craftbookId ?? null,
    cooldownMinutes: lookout?.limits.cooldownMinutes ?? 10,
    maxPerDay: lookout?.limits.maxPerDay ?? 12,
    hours: lookout?.activeHours ?? null,
  };
}

function conditionOf(d: Draft): LookoutCondition {
  if (d.sourceKind === 'website') {
    const prefix = d.pathPrefix.trim();
    const under = prefix ? { pathPrefix: prefix } : {};
    if (d.pageWatch === 'text-appears')
      return { kind: 'text-appears', text: d.words.trim(), ...under };
    return { kind: d.pageWatch, ...under };
  }
  if (d.watchFor === 'motion') return { kind: 'motion' };
  if (d.watchFor === 'person') return { kind: 'subject', subjects: ['person'] };
  if (d.watchFor === 'pet') return { kind: 'subject', subjects: ['cat', 'dog', 'animal'] };
  return { kind: 'ask', question: d.question.trim(), strictness: d.sure ? 'sure' : 'normal' };
}

function actionsOf(d: Draft): LookoutAction[] {
  const out: LookoutAction[] = [];
  if (d.notify) out.push({ kind: 'notify' });
  if (d.sound) out.push({ kind: 'sound', clip: d.sound });
  if (d.speak?.trim()) out.push({ kind: 'speak', text: d.speak.trim() });
  if (d.push) out.push({ kind: 'push' });
  if (d.email?.bindingId) {
    const recipients = d.email.recipients
      .split(/[,;\s]+/)
      .map((r) => r.trim())
      .filter(Boolean);
    out.push({ kind: 'email', bindingId: d.email.bindingId, recipients });
  }
  if (d.askGezel?.instruction.trim()) {
    out.push({
      kind: 'ask-gezel',
      ...(d.askGezel.gezelId ? { gezelId: d.askGezel.gezelId } : {}),
      instruction: d.askGezel.instruction.trim(),
    });
  }
  if (d.craftbook) out.push({ kind: 'run-craftbook', craftbookId: d.craftbook });
  return out;
}

function Tray<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T | null;
  choices: Array<{ id: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="gz-tray"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => onRadioKeyDown(e)}
    >
      {choices.map((c) => (
        <button
          key={c.id}
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: keys in a tray are the house radio control (docs/ux.md); native inputs would duplicate the surface.
          role="radio"
          aria-checked={c.id === value}
          tabIndex={c.id === value || (value === null && c === choices[0]) ? 0 : -1}
          className={`gz-key${c.id === value ? ' gz-key-active' : ''}`}
          onClick={() => onChange(c.id)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/**
 * "When the Mud room camera sees [a cat squatting on the floor], then [play
 * the alarm] and [tell me]." A lookout written as the sentence a person
 * would say, so nobody has to learn what a trigger is.
 */
export function LookoutSentenceBuilder({
  choices,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  choices: LookoutChoices;
  initial?: Lookout;
  busy?: boolean;
  onSave: (input: LookoutInput) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(() => draftFrom(initial, choices));
  const [problem, setProblem] = useState('');
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setD((cur) => ({ ...cur, [key]: value }));
  const sources = [
    ...choices.cameras.map((c) => ({ ...c, kind: 'camera' as const })),
    ...choices.websites.map((c) => ({ ...c, kind: 'website' as const })),
  ];
  const pickSource = (id: string) => {
    const kind = sources.find((x) => x.id === id)?.kind ?? 'camera';
    setD((cur) => ({ ...cur, cameraId: id, sourceKind: kind }));
  };

  const submit = () => {
    const actions = actionsOf(d);
    const website = d.sourceKind === 'website';
    if (!d.cameraId) return setProblem(website ? 'Pick a website.' : 'Pick a camera.');
    if (!website && d.watchFor === 'specific' && d.question.trim().length < 3) {
      return setProblem('Say what to watch for, as a yes-or-no question.');
    }
    if (website && d.pageWatch === 'text-appears' && d.words.trim().length < 2) {
      return setProblem('Say which words to watch for.');
    }
    if (actions.length === 0) return setProblem('Choose at least one thing to do.');
    if (d.email && actions.every((a) => a.kind !== 'email')) {
      return setProblem('Pick the mail account to send from.');
    }
    if (d.email && !d.email.recipients.trim()) return setProblem('Who should the email go to?');
    if (d.askGezel && !d.askGezel.instruction.trim()) {
      return setProblem('Say what they should do.');
    }
    const camera = choices.cameras.find((c) => c.id === d.cameraId)?.name ?? 'the camera';
    const site = choices.websites.find((c) => c.id === d.cameraId)?.name ?? 'the website';
    const fallbackName = website
      ? d.pageWatch === 'text-appears'
        ? `“${d.words.trim()}” on ${site}`
        : `${PAGE_WATCH.find((w) => w.id === d.pageWatch)?.label} on ${site}`
      : d.watchFor === 'specific'
        ? d.question
            .trim()
            .replace(/^is (there )?/i, '')
            .replace(/\?$/, '')
        : `${WATCH_FOR.find((w) => w.id === d.watchFor)?.label} in ${camera}`;
    setProblem('');
    onSave({
      name: (d.name.trim() || fallbackName).slice(0, 80),
      source: { kind: d.sourceKind, bindingId: d.cameraId },
      condition: conditionOf(d),
      actions,
      limits: { cooldownMinutes: d.cooldownMinutes, maxPerDay: d.maxPerDay },
      activeHours: d.hours,
    });
  };

  return (
    <div className="lookout-builder" aria-label={initial ? 'Edit lookout' : 'New lookout'}>
      <div className="lookout-builder-line">
        <span>When</span>
        {sources.length > 1 ? (
          <Select.Root value={d.cameraId} onValueChange={pickSource}>
            <Select.Trigger className="lookout-builder-select" aria-label="Camera or website">
              <Select.Value placeholder="Camera or website" />
            </Select.Trigger>
            <Select.Content>
              {sources.map((c) => (
                <Select.Item key={c.id} value={c.id}>
                  {c.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        ) : (
          <strong>{sources[0]?.name ?? 'the camera'}</strong>
        )}
        <span>{d.sourceKind === 'website' ? 'has' : 'sees'}</span>
      </div>
      {d.sourceKind === 'website' ? (
        <>
          <Tray
            label="Watch for"
            value={d.pageWatch}
            choices={PAGE_WATCH}
            onChange={(v) => set('pageWatch', v)}
          />
          {d.pageWatch === 'text-appears' ? (
            <div className="lookout-builder-question">
              <input
                value={d.words}
                maxLength={200}
                placeholder="sold out"
                aria-label="Words to watch for"
                onChange={(e) => set('words', e.target.value)}
              />
            </div>
          ) : null}
          <div className="lookout-builder-question">
            <input
              value={d.pathPrefix}
              maxLength={300}
              placeholder="/pricing (optional)"
              aria-label="Only pages under this part of the site (optional)"
              onChange={(e) => set('pathPrefix', e.target.value)}
            />
          </div>
          <p className="muted small">
            Checked each time Gezel refreshes the site. Page text is matched as written; nothing on
            the page can change what the lookout does.
          </p>
        </>
      ) : (
        <>
          <Tray
            label="Watch for"
            value={d.watchFor}
            choices={WATCH_FOR}
            onChange={(v) => set('watchFor', v)}
          />
          {d.watchFor === 'specific' ? (
            <div className="lookout-builder-question">
              <textarea
                rows={2}
                value={d.question}
                placeholder="Is a cat squatting or pooping on the floor?"
                aria-label="What to watch for, as a yes-or-no question"
                onChange={(e) => set('question', e.target.value)}
              />
              <label className="small">
                <input
                  type="checkbox"
                  checked={d.sure}
                  onChange={(e) => set('sure', e.target.checked)}
                />{' '}
                Only when it is clearly happening (waits for a second picture)
              </label>
            </div>
          ) : null}
          {d.watchFor !== 'motion' ? (
            <p className="muted small">
              The on-device image reader answers this; the camera's "Recognize what's happening"
              must be on.
            </p>
          ) : null}
        </>
      )}

      <div className="lookout-builder-line">
        <span>then</span>
      </div>
      <div className="lookout-builder-actions">
        <label>
          <input
            type="checkbox"
            checked={d.notify}
            onChange={(e) => set('notify', e.target.checked)}
          />{' '}
          Tell me
          <span className="muted small"> — a notification on this computer</span>
        </label>
        <div>
          <label>
            <input
              type="checkbox"
              checked={d.sound !== null}
              onChange={(e) => set('sound', e.target.checked ? 'chime' : null)}
            />{' '}
            Play a sound
          </label>
          {d.sound ? (
            <Tray label="Sound" value={d.sound} choices={CLIPS} onChange={(v) => set('sound', v)} />
          ) : null}
        </div>
        <div>
          <label>
            <input
              type="checkbox"
              checked={d.speak !== null}
              onChange={(e) => set('speak', e.target.checked ? '' : null)}
            />{' '}
            Say something out loud
          </label>
          {d.speak !== null ? (
            <input
              value={d.speak}
              maxLength={200}
              placeholder="Hey! Off the floor!"
              aria-label="What to say"
              onChange={(e) => set('speak', e.target.value)}
            />
          ) : null}
        </div>
        <label>
          <input type="checkbox" checked={d.push} onChange={(e) => set('push', e.target.checked)} />{' '}
          Send to my phone
          <span className="muted small"> — through the phone channel in Settings</span>
        </label>
        {choices.mailAccounts.length > 0 ? (
          <div>
            <label>
              <input
                type="checkbox"
                checked={d.email !== null}
                onChange={(e) =>
                  set(
                    'email',
                    e.target.checked
                      ? { bindingId: choices.mailAccounts[0]?.id ?? '', recipients: '' }
                      : null,
                  )
                }
              />{' '}
              Email
              <span className="muted small"> — needs the Unrestricted security level</span>
            </label>
            {d.email ? (
              <div className="lookout-builder-sub">
                <input
                  value={d.email.recipients}
                  placeholder="me@example.com"
                  aria-label="Send to"
                  onChange={(e) => set('email', { ...d.email!, recipients: e.target.value })}
                />
                {choices.mailAccounts.length > 1 ? (
                  <Select.Root
                    value={d.email.bindingId}
                    onValueChange={(v) => set('email', { ...d.email!, bindingId: v })}
                  >
                    <Select.Trigger className="lookout-builder-select" aria-label="Send from">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      {choices.mailAccounts.map((m) => (
                        <Select.Item key={m.id} value={m.id}>
                          {m.name}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div>
          <label>
            <input
              type="checkbox"
              checked={d.askGezel !== null}
              onChange={(e) =>
                set('askGezel', e.target.checked ? { gezelId: '', instruction: '' } : null)
              }
            />{' '}
            Have Gezel follow up
          </label>
          {d.askGezel ? (
            <div className="lookout-builder-sub">
              {choices.gezels.length > 0 ? (
                <Select.Root
                  value={d.askGezel.gezelId || '__lead'}
                  onValueChange={(v) =>
                    set('askGezel', { ...d.askGezel!, gezelId: v === '__lead' ? '' : v })
                  }
                >
                  <Select.Trigger className="lookout-builder-select" aria-label="Which crew member">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="__lead">The project lead</Select.Item>
                    {choices.gezels.map((g) => (
                      <Select.Item key={g.id} value={g.id}>
                        {g.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              ) : null}
              <textarea
                rows={2}
                value={d.askGezel.instruction}
                placeholder="Add it to the cat diary with the time, and tell me if it happens twice in a day."
                aria-label="What they should do"
                onChange={(e) => set('askGezel', { ...d.askGezel!, instruction: e.target.value })}
              />
              <span className="muted small">
                A cloud model cannot see the pictures unless the camera allows it.
              </span>
            </div>
          ) : null}
        </div>
        {choices.craftbooks.length > 0 ? (
          <div>
            <label>
              <input
                type="checkbox"
                checked={d.craftbook !== null}
                onChange={(e) =>
                  set('craftbook', e.target.checked ? (choices.craftbooks[0]?.id ?? '') : null)
                }
              />{' '}
              Run a plan
            </label>
            {d.craftbook !== null ? (
              <Select.Root value={d.craftbook} onValueChange={(v) => set('craftbook', v)}>
                <Select.Trigger className="lookout-builder-select" aria-label="Plan">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {choices.craftbooks.map((c) => (
                    <Select.Item key={c.id} value={c.id}>
                      {c.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            ) : null}
          </div>
        ) : null}
      </div>

      <details className="lookout-builder-limits">
        <summary>Name and limits</summary>
        <label>
          Name
          <input
            value={d.name}
            maxLength={80}
            placeholder="Cat on the floor"
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <label>
          Rest after each alert for
          <input
            type="number"
            min={0}
            max={1440}
            value={d.cooldownMinutes}
            onChange={(e) => set('cooldownMinutes', Number(e.target.value))}
          />
          minutes
        </label>
        <label>
          At most
          <input
            type="number"
            min={1}
            max={200}
            value={d.maxPerDay}
            onChange={(e) => set('maxPerDay', Number(e.target.value))}
          />
          times a day
        </label>
        <label>
          <input
            type="checkbox"
            checked={d.hours !== null}
            onChange={(e) => set('hours', e.target.checked ? { from: '22:00', to: '07:00' } : null)}
          />{' '}
          Only between
          {d.hours ? (
            <>
              <input
                type="time"
                value={d.hours.from}
                onChange={(e) => set('hours', { ...d.hours!, from: e.target.value })}
              />
              and
              <input
                type="time"
                value={d.hours.to}
                onChange={(e) => set('hours', { ...d.hours!, to: e.target.value })}
              />
            </>
          ) : (
            ' certain hours'
          )}
        </label>
      </details>

      {problem ? <p className="error small">{problem}</p> : null}
      <div className="gz-mail-link-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : initial ? 'Save' : 'Keep a lookout'}
        </button>
      </div>
    </div>
  );
}
