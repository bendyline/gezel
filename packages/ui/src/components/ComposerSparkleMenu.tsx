import type { PromptAssistAction } from '@bendyline/gezel';
import * as DropdownMenu from '../primitives/DropdownMenu.js';
import { TurnIntentGlyph } from './ComposerTaskBar.js';
import type { ComposerPromptAssist } from './useComposerPromptAssist.js';

const BUSY_LABEL: Record<PromptAssistAction, string> = {
  clarify: 'Rewriting…',
  shorten: 'Shortening…',
  proofread: 'Proofreading…',
  review: 'Reviewing…',
  'shape-image': 'Shaping…',
};

/**
 * The sparkle key beside Task and Send: rewrite or review the draft before
 * it goes. Every action lands in the composer, never in the thread. After a
 * rewrite an Undo key restores the words as they were. See docs/ux.md.
 */
export function ComposerSparkleMenu({
  assist,
  disabled,
  imageModelName,
}: {
  assist: ComposerPromptAssist;
  disabled: boolean;
  /** Set for a direct image gezel: adds "Shape for <model>". */
  imageModelName?: string | undefined;
}) {
  const busy = assist.busy;
  return (
    <>
      {assist.notice && busy === null && (
        <output className="chat-sparkle-notice">{assist.notice}</output>
      )}
      {assist.canUndo && busy === null && (
        <button
          type="button"
          className="chat-task-btn"
          onClick={assist.undo}
          title="Put back the message as you wrote it"
        >
          Undo
        </button>
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="chat-task-btn chat-sparkle-btn"
            disabled={disabled || busy !== null}
            aria-label={busy ? BUSY_LABEL[busy] : 'Improve this message'}
            title={busy ? BUSY_LABEL[busy] : 'Improve this message before you send it'}
            data-testid="chat-sparkle"
          >
            {busy ? BUSY_LABEL[busy] : <TurnIntentGlyph />}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="app-nav-menu" side="top" align="end" sideOffset={4}>
            {imageModelName && (
              <>
                <DropdownMenu.Item
                  className="app-nav-menu-item"
                  onSelect={() => void assist.run('shape-image')}
                >
                  Shape for {imageModelName}
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="app-nav-menu-separator" />
              </>
            )}
            <DropdownMenu.Item
              className="app-nav-menu-item"
              onSelect={() => void assist.run('clarify')}
            >
              Make it clearer
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="app-nav-menu-item"
              onSelect={() => void assist.run('shorten')}
            >
              Shorten
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="app-nav-menu-item"
              onSelect={() => void assist.run('proofread')}
            >
              Fix spelling and grammar
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="app-nav-menu-separator" />
            <DropdownMenu.Item
              className="app-nav-menu-item"
              onSelect={() => void assist.run('review')}
            >
              Review my message
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
}

/**
 * The review's suggestions, in the task strip's frame above the To line.
 * They change nothing until the person asks for a rewrite that applies them.
 */
export function ComposerReviewStrip({ assist }: { assist: ComposerPromptAssist }) {
  const review = assist.review;
  if (!review) return null;
  return (
    <fieldset className="chat-composer-task-bar chat-composer-review" aria-label="Suggestions">
      <div className="chat-composer-task-bar-text chat-composer-review-text">
        <span className="chat-composer-task-bar-eyebrow">
          <TurnIntentGlyph /> Suggestions
        </span>
        <ul className="chat-composer-review-list">
          {review.map((suggestion) => (
            <li key={suggestion}>{suggestion}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className="gz-key chat-composer-review-apply"
        disabled={assist.busy !== null}
        onClick={() => void assist.run('clarify', review)}
      >
        {assist.busy === 'clarify' ? 'Rewriting…' : 'Rewrite with these'}
      </button>
      <button
        type="button"
        className="chat-composer-task-bar-dismiss"
        onClick={assist.dismissReview}
        aria-label="Dismiss the suggestions"
        title="Dismiss"
      >
        ×
      </button>
    </fieldset>
  );
}
