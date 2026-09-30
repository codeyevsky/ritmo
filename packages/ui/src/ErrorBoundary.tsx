import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * Without this, a single bad render unmounts the whole tree and the window goes
 * black with no explanation. Two of these are mounted: one around the routed
 * view, so a broken page leaves the player and the sidebar usable, and one
 * around the entire app as a last resort.
 */

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown above the message, e.g. the route that failed. */
  label?: string;
  /** Changing this resets the boundary — pass the pathname to clear on navigate. */
  resetKey?: string;
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Full-screen treatment for the outermost boundary. */
  fullscreen?: boolean;
  /**
   * Copy is injected rather than translated in place: this boundary is mounted
   * above everything, so it must render without reaching for a hook or a
   * context that may itself be the thing that broke. `RitmoApp` passes
   * translated strings; the English defaults are the last line of defence.
   */
  strings?: ErrorBoundaryStrings;
}

export interface ErrorBoundaryStrings {
  unexpected?: string;
  title?: string;
  body?: string;
  retry?: string;
  copy?: string;
  reload?: string;
}

const DEFAULT_STRINGS = {
  unexpected: 'Unexpected error',
  title: 'This section failed to load',
  body: 'The rest of the app is still running. Copy the error if you want to report it.',
  retry: 'Try again',
  copy: 'Copy error',
  reload: 'Reload the app',
} as const;

interface State {
  error?: Error;
  stack?: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? undefined });
    this.props.onError?.(error, info);
    console.error('ritmo: render failed', error, info.componentStack);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: undefined, stack: undefined });
    }
  }

  private readonly retry = (): void => {
    this.setState({ error: undefined, stack: undefined });
  };

  private readonly copy = (): void => {
    const { error, stack } = this.state;
    const text = `${error?.name}: ${error?.message}\n\n${error?.stack ?? ''}\n\nComponent stack:${stack ?? ''}`;
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  override render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const s = { ...DEFAULT_STRINGS, ...this.props.strings };

    return (
      <div
        role="alert"
        className={
          this.props.fullscreen
            ? 'fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-bg p-8 text-text'
            : 'flex min-h-[60vh] flex-col items-center justify-center gap-5 p-8 text-text'
        }
      >
        <div className="flex w-full max-w-2xl flex-col gap-4 rounded-xl border border-line bg-surface p-6 shadow-pop">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-danger">
              {this.props.label ?? s.unexpected}
            </span>
            <h2 className="text-balance text-xl font-semibold">{s.title}</h2>
            <p className="text-sm text-text-dim">{s.body}</p>
          </div>

          <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs leading-relaxed text-text-dim scrollbar-thin">
            {error.name}: {error.message}
            {stack ? `\n${stack.trimEnd()}` : ''}
          </pre>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.retry}
              className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-transform duration-150 ease-swift hover:scale-[1.03] active:scale-[0.98]"
            >
              {s.retry}
            </button>
            <button
              type="button"
              onClick={this.copy}
              className="rounded-full border border-line px-4 py-2 text-sm font-medium text-text-dim transition-colors hover:bg-surface-2 hover:text-text"
            >
              {s.copy}
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-full border border-line px-4 py-2 text-sm font-medium text-text-dim transition-colors hover:bg-surface-2 hover:text-text"
            >
              {s.reload}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
