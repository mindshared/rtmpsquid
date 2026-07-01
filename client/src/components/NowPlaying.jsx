import { useState } from 'react';
import { niceName, elapsed, liveRate, parseHMS, formatHMS } from '../lib/format';

// The live "now playing" hero: status badge, current title, target vs measured
// bitrate, next track, and the transport controls (Next / Pause / Stop / Jump).
export default function NowPlaying({ status, currentFile, nextTrack, showTitle, onStop, onNext, onPause, onSeek, onToggleTitle, onPickSubtitle, hasSubtitle }) {
  const s = status?.status || 'streaming';
  const standby = s === 'standby';
  const reconnecting = s === 'reconnecting';
  const label = reconnecting ? 'RECONNECTING' : standby ? 'STANDBY' : 'LIVE';
  const live = liveRate(status?.progress?.instBitrate || status?.progress?.bitrate);
  const speed = status?.progress?.speed;
  // Position within the current movie (seconds); null on the standby slate. This
  // is "where we are in this file", not total session uptime (progress.timeMs).
  const filePos = status?.progress?.filePositionSec;
  const hasPos = typeof filePos === 'number' && !standby;
  const [jump, setJump] = useState('');
  const canSeek = onSeek && !standby && !reconnecting;
  const doSeek = () => {
    const secs = parseHMS(jump);
    if (secs == null) return;
    onSeek(secs);
    setJump('');
  };
  return (
    <div className={`nowplaying ${standby ? 'is-standby' : ''} ${reconnecting ? 'is-reconnecting' : ''}`}>
      <div className="np-art">{standby ? '🌙' : '🦑'}</div>
      <div className="np-main">
        <div className="np-badge">
          <span className="streaming-indicator" />
          {label}
        </div>
        <div className="np-title">{standby ? 'Standby slate' : niceName(currentFile) || 'Starting…'}</div>
        <div className="np-meta">
          {status?.resolution} · {status?.videoBitrate} target
          {live ? (
            <>
              {' '}
              · <strong title="measured total throughput to RTMP (video + audio + container)">{live} live</strong>
            </>
          ) : null}
          {speed ? (
            <>
              {' '}
              · <span title="encode/output speed; should sit at ~1x">{speed}</span>
            </>
          ) : null}
          {nextTrack && !standby ? (
            <>
              {' '}
              · next: <strong>{niceName(nextTrack)}</strong>
            </>
          ) : null}
        </div>
        <div className="np-bar">
          <div className="np-bar-pulse" />
        </div>
      </div>
      <div className="np-side">
        <div className="np-time" title={hasPos ? 'Position in the current movie' : 'Total time streamed this session'}>
          {hasPos ? formatHMS(filePos) : elapsed(status?.progress?.timeMs)}
        </div>
        <button
          className="btn btn-secondary btn-small"
          onClick={onNext}
          disabled={standby || reconnecting}
          title="Skip to the next video"
        >
          ⏭ Next
        </button>
        <button
          className="btn btn-secondary btn-small"
          onClick={onPause}
          disabled={reconnecting}
          title="Pause: go offline but keep your place, then Resume"
        >
          ⏸ Pause
        </button>
        {onToggleTitle && (
          <button
            className={`btn btn-secondary btn-small${showTitle ? '' : ' is-off'}`}
            onClick={onToggleTitle}
            title="Show or hide the movie title overlaid on the video (takes effect instantly)"
          >
            🏷 Title: {showTitle ? 'On' : 'Off'}
          </button>
        )}
        {onPickSubtitle && !standby && !reconnecting && (
          <button
            className={`btn btn-secondary btn-small${hasSubtitle ? ' is-on' : ''}`}
            onClick={onPickSubtitle}
            title="Choose subtitles for the movie playing now (applies live, brief re-buffer)"
          >
            💬 Subtitles{hasSubtitle ? ': On' : ''}
          </button>
        )}
        <button className="btn btn-danger btn-small" onClick={onStop}>
          Stop
        </button>
        {canSeek && (
          <div className="np-jump" title="Jump the current movie to an exact time (H:MM:SS)">
            <input
              className="time-input"
              type="text"
              inputMode="numeric"
              placeholder="H:MM:SS"
              value={jump}
              onChange={(e) => setJump(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doSeek();
              }}
            />
            <button className="btn btn-secondary btn-small" onClick={doSeek} disabled={parseHMS(jump) == null}>
              ⇥ Jump
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
