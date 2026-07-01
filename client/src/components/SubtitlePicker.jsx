import { useEffect, useState } from 'react';
import { api } from '../api';
import { niceName } from '../lib/format';

// Per-title subtitle chooser (modal). Loads the auto-detected sidecar subtitles
// for `filePath`, lets the user pick one / turn them off / browse for a file
// elsewhere, and tune the (global) on-screen font size. Selecting commits
// immediately via onApply; the burn-in takes effect when the title next starts.
export default function SubtitlePicker({ filePath, subtitles, fontSize, live = false, onApply, onBrowse, onClose }) {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(true);
  const [size, setSize] = useState(fontSize || 20);

  // The current selection comes from the queue summary (kept in sync by the
  // server broadcast), so it stays correct after a browse-picked file too.
  const current = subtitles?.[filePath] || null;

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .get('/api/subtitles', { params: { filePath } })
      .then(({ data }) => {
        if (!live) return;
        setOptions(Array.isArray(data?.options) ? data.options : []);
        setSupported(data?.supported !== false);
        if (Number.isFinite(data?.fontSize)) setSize(data.fontSize);
      })
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [filePath]);

  const choose = (opt) => onApply({ kind: 'file', path: opt.path, label: opt.label }, undefined);
  const clear = () => onApply(null, undefined);
  const commitSize = (v) => {
    setSize(v);
    onApply(undefined, v); // font size is global; keep the current per-title pick
  };

  const isActive = (opt) => current && (current.label === opt.label || opt.path === current?.path);

  return (
    <div className="modal-overlay">
      <div className="card modal">
        <div className="card-head">
          <h2 style={{ border: 'none', margin: 0, padding: 0 }}>Subtitles</h2>
          <button className="btn btn-danger btn-small" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="muted" style={{ marginTop: 0 }}>
          {niceName(filePath)}
        </p>
        <p className="hint">
          {live
            ? 'Burned into the stream — applies now (brief re-buffer, no reconnect).'
            : 'Burned into the stream — applies when this title next starts.'}
        </p>
        {!supported && (
          <p className="hint" style={{ color: '#e0a030' }}>
            ⚠ This server&apos;s ffmpeg was built without libass, so subtitles can&apos;t be burned in. Your pick is
            saved but won&apos;t show until ffmpeg has the <code>subtitles</code> filter.
          </p>
        )}

        <div className="sub-list scrollable">
          <button className={`sub-row${!current ? ' active' : ''}`} onClick={clear}>
            <span className="sub-label">Off</span>
            {!current && <span className="sub-check">✓</span>}
          </button>

          {loading ? (
            <div className="empty-state">Looking for subtitles…</div>
          ) : options.length === 0 ? (
            <div className="empty-state">None found next to this movie.</div>
          ) : (
            options.map((opt) => (
              <button key={opt.path} className={`sub-row${isActive(opt) ? ' active' : ''}`} onClick={() => choose(opt)} title={opt.path}>
                <span className="sub-label">{opt.label}</span>
                <span className="sub-src muted">{opt.source}</span>
                {isActive(opt) && <span className="sub-check">✓</span>}
              </button>
            ))
          )}
        </div>

        <button className="btn btn-secondary btn-small" style={{ width: '100%', marginTop: '0.5rem' }} onClick={onBrowse}>
          📁 Browse for a subtitle file…
        </button>

        <div className="sub-size">
          <label htmlFor="sub-size-range">Font size</label>
          <input
            id="sub-size-range"
            type="range"
            min="10"
            max="48"
            step="1"
            value={size}
            onChange={(e) => setSize(parseInt(e.target.value, 10))}
            onMouseUp={(e) => commitSize(parseInt(e.target.value, 10))}
            onTouchEnd={(e) => commitSize(parseInt(e.target.value, 10))}
          />
          <span className="sub-size-val">{size}</span>
        </div>
      </div>
    </div>
  );
}
