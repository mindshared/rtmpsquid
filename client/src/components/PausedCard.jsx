import { useState } from 'react';
import { niceName, elapsed, formatHMS, parseHMS } from '../lib/format';

// Shown while paused (offline but holding the spot). Resume reconnects and picks
// up the same movie — at the remembered offset, or at an exact time you type in.
export default function PausedCard({ queue, onResume, onStop }) {
  const savedOffset = queue?.resumeOffset != null ? queue.resumeOffset : null;
  const at = savedOffset != null ? elapsed(savedOffset * 1000) : null;
  const [time, setTime] = useState(savedOffset != null ? formatHMS(savedOffset) : '');
  const typed = parseHMS(time);
  // Resume at the typed time when valid; otherwise fall back to the saved spot.
  const doResume = () => onResume(typed != null ? typed : undefined);
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
        <div className="np-jump" title="Resume at an exact time (H:MM:SS)">
          <span className="muted">Resume at</span>
          <input
            className="time-input"
            type="text"
            inputMode="numeric"
            placeholder="H:MM:SS"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doResume();
            }}
          />
        </div>
      </div>
      <div className="np-side">
        <button className="btn btn-primary btn-small" onClick={doResume}>
          ▶ Resume{typed != null && typed !== savedOffset ? ` at ${formatHMS(typed)}` : ''}
        </button>
        <button className="btn btn-danger btn-small" onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  );
}
