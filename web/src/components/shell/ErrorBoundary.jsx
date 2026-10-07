import { Component } from 'react';
import { RotateCw, TriangleAlert, WifiOff } from 'lucide-react';

/**
 * A page that throws while drawing, or whose code cannot be fetched, shows
 * this instead of a blank screen (A1-11). The rail and the dock stay, so
 * the rest of the app is still a click away. Keyed on the path by App.jsx,
 * so going somewhere else starts clean.
 */
export class PageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // The same channel the rest of the app reports to (lib/errorReporting.js listens for these).
    try { window.dispatchEvent(new ErrorEvent('error', { error, message: String(error?.message || error) })); } catch { /* old browser */ }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A lazy page whose file cannot be fetched: the server, not the page.
    const offline = /dynamically imported module|Failed to fetch|Loading chunk|error loading/i.test(String(error?.message || ''));
    return (
      <div className="page">
        <section className="mg-glass mg-empty" style={{ padding: '72px 24px', borderRadius: 26 }} role="alert">
          <span className="mg-empty__mark" style={{ width: 64, height: 64 }}>
            {offline ? <WifiOff size={26} strokeWidth={1.8} aria-hidden="true" /> : <TriangleAlert size={26} strokeWidth={1.8} aria-hidden="true" />}
          </span>
          <h2 className="mg-empty__title" style={{ fontSize: 18 }}>{offline ? 'Can’t reach the server' : 'Something broke on this page'}</h2>
          <p className="mg-empty__text">
            {offline
              ? 'This page could not be loaded. Check your connection, then reload.'
              : 'The page hit an error while drawing. Reload to try again; if it keeps happening, tell an admin what you were doing.'}
          </p>
          <button type="button" className="mg-btn mg-btn--primary" style={{ marginTop: 8 }} onClick={() => window.location.reload()}>
            <RotateCw size={16} strokeWidth={2} aria-hidden="true" />Reload
          </button>
        </section>
      </div>
    );
  }
}
