import { useState } from 'react';
import { niceName, formatHMS, parseHMS } from '../lib/format';

// Shown after a skip or a crash. Explains what happened and where the movie
// stopped, and offers a one-click recovery:
//   - stopped after a crash  → "Resume {file} at [H:MM:SS]" (prefilled to the crash time)
//   - still live after a skip → "Play {file} next" (re-queue it)
// Dismissible either way.
export default function RecoveryCard({ incident, streaming, onRecover, onRequeue, onDismiss }) {
  const { reason, file, path, offset = 0, message } = incident || {};
  const [time, setTime] = useState(formatHMS(offset));
  const typed = parseHMS(time);

  const crashed = reason === 'error';
  const heading = crashed ? '⚠ Stream stopped' : '⏭ Skipped a file';
  const canResume = crashed && !streaming && path; // resume-at-time only makes sense once stopped

  return (
    <div className="recovery-card">
      <div className="rc-main">
        <div className="rc-badge">{heading}</div>
        <div className="rc-title">{niceName(file) || 'A movie'}</div>
        <div className="rc-meta">
          {crashed ? 'Stopped' : 'Stopped playing'} at <strong>{formatHMS(offset) || '0:00:00'}</strong>
          {message ? <span className="rc-msg"> · {message}</span> : null}
        </div>
      </div>
      <div className="rc-actions">
        {canResume && (
          <>
            <input
              className="time-input"
              type="text"
              inputMode="numeric"
              placeholder="H:MM:SS"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && typed != null) onRecover(typed);
              }}
              title="Resume the movie at this time"
            />
            <button className="btn btn-primary btn-small" disabled={typed == null} onClick={() => onRecover(typed)}>
              ▶ Resume at {formatHMS(typed) || '—'}
            </button>
          </>
        )}
        {!crashed && path && (
          <button className="btn btn-secondary btn-small" onClick={() => onRequeue(path)}>
            ↩ Play {niceName(file)} next
          </button>
        )}
        <button className="btn btn-secondary btn-small" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
