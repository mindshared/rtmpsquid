// Top bar: brand + context actions. Which transport button shows depends on
// whether we're live, paused, or idle.
export default function AppBar({
  hasLibrary,
  streaming,
  paused,
  busy,
  onReshuffle,
  onOpenSettings,
  onPause,
  onResume,
  onStop,
  onGoLive,
  onLogout,
}) {
  return (
    <header className="appbar">
      <div className="brand">🦑 RTMP Squid</div>
      <div className="appbar-actions">
        {hasLibrary && (
          <button
            className="btn btn-secondary btn-small"
            onClick={onReshuffle}
            disabled={busy}
            title="Fresh random queue"
          >
            🔀 Shuffle
          </button>
        )}
        <button className="btn btn-secondary btn-small" onClick={onOpenSettings}>
          ⚙ Settings
        </button>
        {streaming && (
          <button
            className="btn btn-secondary btn-small"
            onClick={onPause}
            disabled={busy}
            title="Go offline but keep your place"
          >
            ⏸ Pause
          </button>
        )}
        {paused && (
          <button className="btn btn-primary btn-small" onClick={onResume} disabled={busy}>
            ▶ Resume
          </button>
        )}
        {streaming || paused ? (
          <button className="btn btn-danger btn-small" onClick={onStop} disabled={busy}>
            ■ Stop
          </button>
        ) : (
          <button className="btn btn-primary btn-small" onClick={onGoLive} disabled={!hasLibrary || busy}>
            ● Go Live
          </button>
        )}
        <button className="btn btn-secondary btn-small" onClick={onLogout} title="Log out">
          ⏻
        </button>
      </div>
    </header>
  );
}
