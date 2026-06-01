import { niceName, elapsed, liveRate } from '../lib/format';

// The live "now playing" hero: status badge, current title, target vs measured
// bitrate, next track, and the transport controls (Next / Pause / Stop).
export default function NowPlaying({ status, currentFile, nextTrack, onStop, onNext, onPause }) {
  const s = status?.status || 'streaming';
  const standby = s === 'standby';
  const reconnecting = s === 'reconnecting';
  const label = reconnecting ? 'RECONNECTING' : standby ? 'STANDBY' : 'LIVE';
  const live = liveRate(status?.progress?.instBitrate || status?.progress?.bitrate);
  const speed = status?.progress?.speed;
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
        <div className="np-time">{elapsed(status?.progress?.timeMs)}</div>
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
        <button className="btn btn-danger btn-small" onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  );
}
