import { LinearDocView } from '@bendyline/squisq-react';
import type { ComponentProps, MouseEventHandler } from 'react';
import { GEZEL_LIGHT_SURFACE, gezelChatThemeForMode } from '../../components/chat-theme.js';

/** The readable Home article, shared by the daemon UI and local startup. */
export function IntroArticleDocument({
  doc,
  mode,
  onClickCapture,
}: {
  doc: ComponentProps<typeof LinearDocView>['doc'];
  mode: 'light' | 'dark';
  onClickCapture?: MouseEventHandler<HTMLDivElement>;
}) {
  return (
    <div className="home-intro-page">
      <div className="home-intro-doc" onClickCapture={onClickCapture}>
        <LinearDocView
          doc={doc}
          className="gezel-article-view"
          theme={gezelChatThemeForMode(mode)}
          surface={mode === 'light' ? GEZEL_LIGHT_SURFACE : undefined}
          thinMargins
          imageDisplayMode="inline"
          showCover={false}
          linkSchemes={['knowledge']}
        />
      </div>
    </div>
  );
}
