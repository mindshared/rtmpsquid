import { Component } from 'react';

/**
 * Catches render/lifecycle errors in its subtree and shows a contained fallback
 * instead of letting React unmount the whole app to a blank screen.
 *
 * React has no hook equivalent for error catching, so this is intentionally a
 * class component (getDerivedStateFromError + componentDidCatch). Wrap the app
 * root once, and wrap individual panels so a crash in one (e.g. a malformed
 * socket payload) degrades just that panel — the rest of the UI keeps working.
 *
 * Props:
 *   label    – short name of the region, shown in the fallback ("Settings", …)
 *   compact  – render a small inline fallback (for panels) vs a full-screen one
 *   children – the protected subtree
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface it for debugging; never rethrow (that would blank the app).
    console.error(`[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ''}]`, error, info?.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const label = this.props.label || 'This section';
    if (this.props.compact) {
      return (
        <div className="error-fallback compact" role="alert">
          <span>⚠ {label} hit an error and was paused.</span>
          <button className="btn btn-secondary btn-small" onClick={this.reset}>
            Retry
          </button>
        </div>
      );
    }
    return (
      <div className="error-fallback" role="alert">
        <div className="error-art">🛟</div>
        <h2>{label} crashed — but the app didn&apos;t.</h2>
        <p className="muted">{String(error?.message || error)}</p>
        <div className="error-actions">
          <button className="btn btn-secondary btn-small" onClick={this.reset}>
            Try again
          </button>
          <button className="btn btn-primary btn-small" onClick={() => window.location.reload()}>
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
