import { niceName, elapsed } from '../lib/format';

// Shown while paused (offline but holding the spot). Resume reconnects and picks
// up the same movie at the remembered offset.
export default function PausedCard({ queue, onResume, onStop }) {
  const at = queue?.resumeOffset != null ? elapsed(queue.resumeOffset * 1000) : null;
  return (
    <div className="nowplaying is-standby">
      <div className="np-art">⏸</div>
      <div className="np-main">
        <div className="np-badge">PAUSED · OFFLINE</div>
        <div className="np-title">{niceName(queue?.resumeFile) || 'Paused'}</div>
        <div className="np-meta">
          Disconnected from the platform. Resume picks up the same movie
          {at ? (
            <>
              {' '}
              at <strong>{at}</strong>
            </>
          ) : null}
          . Change settings now if you like.
        </div>
      </div>
      <div className="np-side">
        <button className="btn btn-primary btn-small" onClick={onResume}>
          ▶ Resume
        </button>
        <button className="btn btn-danger btn-small" onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  );
}
