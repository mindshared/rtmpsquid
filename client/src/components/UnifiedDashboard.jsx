import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../api';
import FolderBrowser from './FolderBrowser';

const basename = (p) => (p ? p.split(/[/\\]/).pop() : '');
const niceName = (p) => basename(p).replace(/\.[^.]+$/, '').replace(/[._]/g, ' ');
const elapsed = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
const ls = (k, d) => { const v = localStorage.getItem(k); return v === null ? d : v; };
const LIB_CAP = 300;

function NowPlaying({ status, currentFile, nextTrack, onStop }) {
  const s = status?.status || 'streaming';
  const standby = s === 'standby';
  const reconnecting = s === 'reconnecting';
  const label = reconnecting ? 'RECONNECTING' : standby ? 'STANDBY' : 'LIVE';
  return (
    <div className={`nowplaying ${standby ? 'is-standby' : ''} ${reconnecting ? 'is-reconnecting' : ''}`}>
      <div className="np-art">{standby ? '🌙' : '🦑'}</div>
      <div className="np-main">
        <div className="np-badge"><span className="streaming-indicator" />{label}</div>
        <div className="np-title">{standby ? 'Standby slate' : (niceName(currentFile) || 'Starting…')}</div>
        <div className="np-meta">
          {status?.resolution} · {status?.videoBitrate}
          {nextTrack && !standby ? <> · next: <strong>{niceName(nextTrack)}</strong></> : null}
        </div>
        <div className="np-bar"><div className="np-bar-pulse" /></div>
      </div>
      <div className="np-side">
        <div className="np-time">{elapsed(status?.progress?.timeMs)}</div>
        <button className="btn btn-danger btn-small" onClick={onStop}>Stop</button>
      </div>
    </div>
  );
}

function QueueView({ socket, queue, streamStatus, setQueue, notify, onLogout }) {
  const [library, setLibrary] = useState({ folder: null, files: [] });
  const [query, setQuery] = useState('');
  const [libQuery, setLibQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [overIndex, setOverIndex] = useState(null);
  const dragRef = useRef(null); // { source:'library'|'queue', path?, fromIndex? }

  const [rtmpUrl, setRtmpUrl] = useState(ls('rs_rtmp', 'rtmp://ingest.angelthump.com/live'));
  const [streamKey, setStreamKey] = useState(ls('rs_key', ''));
  const [resolution, setResolution] = useState(ls('rs_res', '1920x1080'));
  const [videoFit, setVideoFit] = useState(ls('rs_fit', 'fit'));
  const [bitrate, setBitrate] = useState(ls('rs_vb', '3000k'));
  const [audioBitrate, setAudioBitrate] = useState(ls('rs_ab', '160k'));
  const [minSizeMB, setMinSizeMB] = useState(ls('rs_minmb', '5'));
  const save = (k, v, set) => { localStorage.setItem(k, v); set(v); };

  const fetchLibrary = () => api.get('/api/library').then(({ data }) => setLibrary(data)).catch(() => {});
  useEffect(() => { fetchLibrary(); }, []);
  useEffect(() => {
    if (!socket) return;
    const onLib = (lib) => setLibrary(lib);
    socket.on('library:updated', onLib);
    return () => socket.off('library:updated', onLib);
  }, [socket]);

  const streaming = !!queue?.streaming;
  const files = queue?.files || [];
  const currentIndex = streaming && queue?.currentFile ? files.findIndex((f) => basename(f) === queue.currentFile) : -1;
  const nextTrack = currentIndex >= 0 && currentIndex < files.length - 1 ? files[currentIndex + 1] : null;
  const searching = query.trim().length > 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.map((path, index) => ({ path, index })).filter(({ path }) => !q || basename(path).toLowerCase().includes(q));
  }, [files, query]);

  const libFiltered = useMemo(() => {
    const q = libQuery.trim().toLowerCase();
    return library.files.filter((p) => !q || basename(p).toLowerCase().includes(q));
  }, [library.files, libQuery]);

  const call = async (fn, label) => {
    setBusy(true);
    try { const { data } = await fn(); if (data?.files) setQueue(data); return data; }
    catch (e) { notify?.(`${label}: ${e.response?.data?.error || e.message}`, 'error'); }
    finally { setBusy(false); }
  };

  const useFolder = () => {
    const folder = folderPath.trim() || queue?.library;
    if (!folder) { notify?.('Choose a folder first', 'error'); return; }
    return call(() => api.post('/api/queue/library', { folderPath: folder, minSizeMB: parseFloat(minSizeMB) || 0 }), 'Library')
      .then((d) => { if (d) { notify?.(`Library set · ${d.libraryCount} movies (≥ ${minSizeMB}MB)`); setDrawerOpen(false); fetchLibrary(); } });
  };
  const reshuffle = () => call(() => api.post('/api/queue/reshuffle'), 'Shuffle');
  const removeAt = (index) => call(() => api.delete(`/api/queue/${index}`), 'Remove');
  const addAt = (path, index) => call(() => api.post('/api/queue/add', { filePath: path, index }), 'Add');
  const reorder = (from, to) => {
    if (from == null || to == null || from === to) return;
    const arr = [...files]; const [m] = arr.splice(from, 1); arr.splice(to, 0, m);
    setQueue({ ...queue, files: arr });
    call(() => api.post('/api/queue/reorder', { fromIndex: from, toIndex: to }), 'Reorder');
  };

  // Cross-list drop: library item -> insert; queue item -> reorder.
  const dropAt = (targetIndex) => {
    const d = dragRef.current; dragRef.current = null; setOverIndex(null);
    if (!d) return;
    if (d.source === 'library') addAt(d.path, targetIndex);
    else if (d.source === 'queue') reorder(d.fromIndex, targetIndex);
  };

  const goLive = async () => {
    if (!streamKey.trim()) { notify?.('Add your stream key in Settings', 'error'); setDrawerOpen(true); return; }
    await call(() => api.post('/api/queue/start', { rtmpUrl, streamKey, resolution, bitrate, audioBitrate, audioChannels: 2, forceStretch: videoFit === 'stretch' }), 'Go live');
    notify?.('Going live');
  };
  const stop = () => call(() => api.post('/api/queue/stop'), 'Stop');

  const hasLibrary = queue && queue.libraryCount > 0;

  return (
    <div className="player-shell wide">
      <header className="appbar">
        <div className="brand">🦑 RTMP Squid</div>
        <div className="appbar-actions">
          {hasLibrary && <button className="btn btn-secondary btn-small" onClick={reshuffle} disabled={busy} title="Fresh random queue">🔀 Shuffle</button>}
          <button className="btn btn-secondary btn-small" onClick={() => setDrawerOpen(true)}>⚙ Settings</button>
          {streaming
            ? <button className="btn btn-danger btn-small" onClick={stop}>■ Stop</button>
            : <button className="btn btn-primary btn-small" onClick={goLive} disabled={!hasLibrary || busy}>● Go Live</button>}
          <button className="btn btn-secondary btn-small" onClick={onLogout} title="Log out">⏻</button>
        </div>
      </header>

      {!queue ? (
        <div className="empty-state">Loading…</div>
      ) : !hasLibrary ? (
        <section className="empty-create">
          <div className="empty-art">🎬</div>
          <h2>Point me at your movies</h2>
          <p>Pick a folder and I'll auto-fill a never-ending random queue.</p>
          <button className="btn btn-primary" onClick={() => setDrawerOpen(true)}>Choose folder</button>
        </section>
      ) : (
        <div className="player-grid">
          {/* ---- main: now playing + queue ---- */}
          <main className="player-body scrollable">
            {streaming && <NowPlaying status={streamStatus} currentFile={queue.currentFile} nextTrack={nextTrack} onStop={stop} />}

            <section
              className="queue"
              onDragOver={(e) => { if (dragRef.current) e.preventDefault(); }}
              onDrop={() => dropAt(files.length)}
            >
              <div className="queue-head">
                <div>
                  <h2 className="queue-title">Up Next</h2>
                  <span className="muted">{files.length} queued · auto-fills under 5</span>
                </div>
                <input className="search" type="search" value={query} placeholder="Search the queue…" onChange={(e) => setQuery(e.target.value)} />
              </div>
              {searching && <p className="hint">Showing {filtered.length} match(es). Clear search to drag.</p>}

              <div className="queue-list">
                {filtered.length === 0 && <div className="empty-state">{searching ? `No matches for “${query}”.` : 'Drag movies here from the library →'}</div>}
                {filtered.map(({ path, index }) => {
                  const playing = index === currentIndex;
                  const showDivider = streaming && !searching && index === currentIndex + 1;
                  return (
                    <div key={`${path}-${index}`}>
                      {showDivider && <div className="next-divider">Up next</div>}
                      <div
                        className={`track ${playing ? 'playing' : ''} ${overIndex === index ? 'drop-target' : ''}`}
                        draggable={!searching}
                        onDragStart={() => { dragRef.current = { source: 'queue', fromIndex: index }; }}
                        onDragEnter={() => setOverIndex(index)}
                        onDragOver={(e) => { if (dragRef.current) e.preventDefault(); }}
                        onDrop={(e) => { e.stopPropagation(); dropAt(index); }}
                      >
                        {!searching && <span className="track-handle" title="Drag to reorder">⠿</span>}
                        <span className="track-num">{playing ? '♪' : index + 1}</span>
                        <span className="track-name">{niceName(path)}</span>
                        <div className="track-actions">
                          <button className="icon-btn danger" title="Remove" onClick={() => removeAt(index)}>✕</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </main>

          {/* ---- side: library ---- */}
          <aside className="library-panel">
            <div className="lib-head">
              <h2 className="queue-title" style={{ fontSize: '1.1rem' }}>Library</h2>
              <span className="muted">{library.files.length} movies</span>
            </div>
            <input className="search lib-search" type="search" value={libQuery} placeholder="Search library…" onChange={(e) => setLibQuery(e.target.value)} />
            <p className="hint">Drag a movie into the queue, or tap +</p>
            <div className="lib-list scrollable">
              {libFiltered.length === 0 && <div className="empty-state">No movies match.</div>}
              {libFiltered.slice(0, LIB_CAP).map((path) => (
                <div
                  key={path}
                  className="lib-row"
                  draggable
                  onDragStart={() => { dragRef.current = { source: 'library', path }; }}
                  title={path}
                >
                  <span className="lib-handle">⠿</span>
                  <span className="lib-name">{niceName(path)}</span>
                  <button className="icon-btn" title="Add to queue" onClick={() => addAt(path, null)}>＋</button>
                </div>
              ))}
              {libFiltered.length > LIB_CAP && <div className="hint" style={{ padding: '0.5rem 0.75rem' }}>Showing {LIB_CAP} of {libFiltered.length} — search to narrow.</div>}
            </div>
          </aside>
        </div>
      )}

      {drawerOpen && (
        <>
          <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} />
          <aside className="drawer scrollable">
            <div className="drawer-head"><h2>Settings</h2><button className="icon-btn" onClick={() => setDrawerOpen(false)}>✕</button></div>

            <div className="drawer-section">
              <h3>Movie library</h3>
              <p className="muted" style={{ marginBottom: '0.6rem' }}>
                {queue?.library || 'none set'} · {queue?.libraryCount || 0} movies
                {queue?.minMovieMB != null ? ` · ignoring < ${queue.minMovieMB}MB` : ''}
              </p>
              <div className="row">
                <input type="text" value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="Folder under media root…" />
                <button className="btn btn-secondary btn-small" onClick={() => setShowBrowser(true)}>Browse</button>
              </div>
              <label className="field">Smallest file to include (MB)
                <input type="number" min="0" step="1" value={minSizeMB} onChange={(e) => save('rs_minmb', e.target.value, setMinSizeMB)} />
              </label>
              <button className="btn btn-primary btn-small btn-full" onClick={useFolder} disabled={busy || (!folderPath.trim() && !queue?.library)}>
                {busy ? 'Scanning…' : (folderPath.trim() ? 'Use this folder' : 'Rescan with these settings')}
              </button>
            </div>

            <div className="drawer-section">
              <h3>Destination</h3>
              <label className="field">RTMP URL<input type="text" value={rtmpUrl} onChange={(e) => save('rs_rtmp', e.target.value, setRtmpUrl)} /></label>
              <label className="field">Stream key<input type="password" value={streamKey} onChange={(e) => save('rs_key', e.target.value, setStreamKey)} placeholder="paste your key" /></label>
            </div>

            <div className="drawer-section">
              <h3>Quality</h3>
              <div className="grid-2">
                <label className="field">Resolution
                  <select value={resolution} onChange={(e) => save('rs_res', e.target.value, setResolution)}>
                    <option value="1280x720">720p</option><option value="1920x1080">1080p</option><option value="2560x1440">1440p</option>
                  </select>
                </label>
                <label className="field">Fit
                  <select value={videoFit} onChange={(e) => save('rs_fit', e.target.value, setVideoFit)}>
                    <option value="fit">Fit (bars)</option><option value="stretch">Stretch</option>
                  </select>
                </label>
                <label className="field">Video bitrate
                  <select value={bitrate} onChange={(e) => save('rs_vb', e.target.value, setBitrate)}>{['2000k','3000k','4000k','5000k','6000k'].map((b) => <option key={b} value={b}>{b}</option>)}</select>
                </label>
                <label className="field">Audio bitrate
                  <select value={audioBitrate} onChange={(e) => save('rs_ab', e.target.value, setAudioBitrate)}>{['128k','160k','192k','256k','320k'].map((b) => <option key={b} value={b}>{b}</option>)}</select>
                </label>
              </div>
            </div>
          </aside>
        </>
      )}

      {showBrowser && <FolderBrowser onSelectFolder={(p) => { setFolderPath(p); setShowBrowser(false); }} onClose={() => setShowBrowser(false)} />}
    </div>
  );
}

export default QueueView;
