import { Component, type ErrorInfo, type ReactNode } from 'react';

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
}

export class TabErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(prev: Props) {
    // New tab activated → drop any prior crash so the new tab renders clean.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to the console so the stack is recoverable in DevTools / logs.
    console.error('[TabErrorBoundary] tab content crashed:', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="tab-error-boundary" role="alert">
          <h2>This tab hit an error.</h2>
          <p className="muted">
            Something in this tab failed to render. The rest of the app is still working — you can
            close this tab or switch to another.
          </p>
          <pre className="tab-error-boundary-detail">{error.message}</pre>
          <button type="button" className="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
