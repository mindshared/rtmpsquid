import { useEffect, useRef, useState } from 'react';

// Live raw-ffmpeg view: the latest reconstructed streamer status line up top
// (frame/size/time/bitrate/speed/drop/dup) plus a scrolling tail of status ticks
// and stderr warnings from BOTH the streamer and the per-file feeder. This is the
// "see exactly what ffmpeg is doing/saying right now" panel — including catching
// a stuck-clock bitrate creep (out_time frozen while size/bitrate climb).
export default function FfmpegLogPanel({ entries = [], lastStatus }) {
  const [open, setOpen] = useState(false);
  const [warningsOnly, setWarningsOnly] = useState(false);
  const bodyRef = useRef(null);
  const pinnedRef = useRef(true); // stay pinned to the bottom unless the user scrolls up

  const shown = warningsOnly ? entries.filter((e) => e.kind === 'log') : entries;

  useEffect(() => {
    const el = bodyRef.current;
    if (open && el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, open]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <section className="ffmpeg-panel">
      <div className="ffmpeg-head">
        <button className="ffmpeg-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '▾' : '▸'} ffmpeg
        </button>
        <code className="ffmpeg-status" title="latest streamer status line">
          {lastStatus || 'no status yet'}
        </code>
        {open && (
          <label className="ffmpeg-filter" title="show only warnings/errors">
            <input type="checkbox" checked={warningsOnly} onChange={(e) => setWarningsOnly(e.target.checked)} />{' '}
            warnings only
          </label>
        )}
      </div>
      {open && (
        <div className="ffmpeg-body" ref={bodyRef} onScroll={onScroll}>
          {shown.length === 0 && <div className="ffmpeg-empty">No ffmpeg output yet — start a stream.</div>}
          {shown.map((e, i) => (
            <div key={i} className={`ffmpeg-line src-${e.src} kind-${e.kind}`}>
              <span className="ffmpeg-src">{e.src === 'streamer' ? 'OUT' : 'ENC'}</span>
              <span className="ffmpeg-text">{e.line}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
