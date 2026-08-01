import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ReportErrorLink } from './ReportErrorLink.js';

/**
 * Guards a single tab's content. A render crash inside one tab (e.g. a
 * project whose data trips an unhandled case) would otherwise unwind the
 * whole React tree and blank the entire window. This boundary contains the
 * failure to the tab, shows a readable message, and offers a retry — the
 * rest of the app (header, tab bar, Home) stays interactive.
 *
 * `resetKey` resets the boundary when the active tab changes, so switching
 * away from a broken tab and back (or to another tab) clears the error
 * state instead of stickily showing the previous crash.
 */
interface Props {
  resetKey: string | null;
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

const CLEAR: State = { error: null, componentStack: null };

export class TabErrorBoundary extends Component<Props, State> {
  override state: State = CLEAR;

  static getDerivedStateFromError(error: Error): State {
    return { error, componentStack: null };
  }

  override componentDidUpdate(prev: Props) {
    // New tab activated → drop any prior crash so the new tab renders clean.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState(CLEAR);
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to the console so the stack is recoverable in DevTools / logs.
    console.error('[TabErrorBoundary] tab content crashed:', error, info.componentStack);
    // Also keep it: this is the one place in the UI holding a real Error,
    // and the component stack is what makes a crash report actionable.
    this.setState({ componentStack: info.componentStack ?? null });
  }

  override render() {
    const { error, componentStack } = this.state;
    if (error) {
      return (
        <div className="tab-error-boundary" role="alert">
          <h2>This tab hit an error.</h2>
          <p className="muted">
            Something in this tab failed to render. The rest of the app is still working — you can
            close this tab or switch to another.
          </p>
          <pre className="tab-error-boundary-detail">{error.message}</pre>
          <div className="tab-error-boundary-actions">
            <button type="button" className="primary" onClick={() => this.setState(CLEAR)}>
              Try again
            </button>
            <ReportErrorLink
              className="home-link"
              report={{
                surface: 'tab-crash',
                message: error.message,
                stack: error.stack,
                componentStack: componentStack ?? undefined,
              }}
            />
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
