import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../api';
import FolderBrowser from './FolderBrowser';

const basename = (p) => (p ? p.split(/[/\\]/).pop() : '');
const niceName = (p) => basename(p).replace(/\.[^.]+$/, '').replace(/[._]/g, ' ');
const elapsed = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
// ffmpeg reports the live streamer throughput as e.g. "1234.5kbits/s" (or "N/A"
// before the first frame). Normalise to a tidy "1235k" or null.
const liveRate = (raw) => {
  if (!raw || raw === 'N/A') return null;
  const m = /([\d.]+)\s*(k|m)?bits\/s/i.exec(raw);
  if (!m) return null;
  const mult = { m: 1000, k: 1, '': 0.001 }[(m[2] || '').toLowerCase()];
  return `${Math.round(parseFloat(m[1]) * mult)}k`;
};
const ls = (k, d) => { const v = localStorage.getItem(k); return v === null ? d : v; };
// Normalise a stored video bitrate to ffmpeg "M" form (e.g. legacy "3000k" -> "3M",
// "1400k" -> "1.4M"); pass through values already in M.
const toM = (v) => {
  if (!v) return '3M';
  if (/m$/i.test(v)) return v;
  const k = parseFloat(v);
  return Number.isFinite(k) ? `${k / 1000}M` : '3M';
};
const LIB_PAGE = 200; // library rows per page (Prev/Next pages through the rest)
// Advanced-mode encode overrides. Defaults mirror the platform-safe server
// encode (Twitch/Kick/AngelThump). Blank maxrate/bufsize = derived from bitrate.
const ADV_DEFAULTS = {
  preset: 'veryfast', profile: 'high', tune: 'zerolatency', level: '', pixfmt: 'yuv420p',
  gopSeconds: '2', bframes: '0', sceneCut: '0',
  rateControl: 'cbr', crf: '23', maxrate: '', bufsize: '',
  audioCodec: 'aac', audioSampleRate: '48000', extraArgs: '',
};

function NowPlaying({ status, currentFile, nextTrack, onStop, onNext }) {
  const s = status?.status || 'streaming';
  const standby = s === 'standby';
  const reconnecting = s === 'reconnecting';
  const label = reconnecting ? 'RECONNECTING' : standby ? 'STANDBY' : 'LIVE';
  const live = liveRate(status?.progress?.bitrate);
  return (
    <div className={`nowplaying ${standby ? 'is-standby' : ''} ${reconnecting ? 'is-reconnecting' : ''}`}>
      <div className="np-art">{standby ? '🌙' : '🦑'}</div>
      <div className="np-main">
        <div className="np-badge"><span className="streaming-indicator" />{label}</div>
        <div className="np-title">{standby ? 'Standby slate' : (niceName(currentFile) || 'Starting…')}</div>
        <div className="np-meta">
          {status?.resolution} · {status?.videoBitrate} target
          {live ? <> · <strong title="measured total throughput to RTMP (video + audio + container)">{live} live</strong></> : null}
          {nextTrack && !standby ? <> · next: <strong>{niceName(nextTrack)}</strong></> : null}
        </div>
        <div className="np-bar"><div className="np-bar-pulse" /></div>
      </div>
      <div className="np-side">
        <div className="np-time">{elapsed(status?.progress?.timeMs)}</div>
        <button className="btn btn-secondary btn-small" onClick={onNext} disabled={standby || reconnecting} title="Skip to the next video">⏭ Next</button>
        <button className="btn btn-danger btn-small" onClick={onStop}>Stop</button>
      </div>
    </div>
  );
}

function QueueView({ socket, queue, streamStatus, setQueue, notify, onLogout }) {
  const [library, setLibrary] = useState({ folder: null, files: [] });
  const [query, setQuery] = useState('');
  const [libQuery, setLibQuery] = useState('');
  const [libPage, setLibPage] = useState(0);
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
  const [bitrate, setBitrate] = useState(toM(ls('rs_vb', '3M')));
  const [rateControl, setRateControl] = useState(ls('rs_rc', 'cbr'));
  const [audioBitrate, setAudioBitrate] = useState(ls('rs_ab', '160k'));
  const [fps, setFps] = useState(ls('rs_fps', '30'));
  const [audioChannels, setAudioChannels] = useState(ls('rs_ac', '2'));
  const [order, setOrder] = useState(ls('rs_order', 'shuffle'));
  const [minSizeMB, setMinSizeMB] = useState(ls('rs_minmb', '5'));
  const save = (k, v, set) => { localStorage.setItem(k, v); set(v); };

  // Advanced encoder overrides.
  const [advancedMode, setAdvancedMode] = useState(ls('rs_advmode', '0') === '1');
  const [adv, setAdv] = useState(() => { try { return { ...ADV_DEFAULTS, ...JSON.parse(ls('rs_adv', '{}')) }; } catch { return { ...ADV_DEFAULTS }; } });
  const setAdvField = (k, v) => { const next = { ...adv, [k]: v }; setAdv(next); localStorage.setItem('rs_adv', JSON.stringify(next)); };
  const resetAdv = () => { setAdv({ ...ADV_DEFAULTS }); localStorage.setItem('rs_adv', JSON.stringify(ADV_DEFAULTS)); };
  const toggleAdvanced = (on) => { setAdvancedMode(on); localStorage.setItem('rs_advmode', on ? '1' : '0'); };

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

  // Page the library so even huge folders are fully browsable (Prev/Next).
  const libPageCount = Math.max(1, Math.ceil(libFiltered.length / LIB_PAGE));
  const safePage = Math.min(libPage, libPageCount - 1);
  const libPageItems = libFiltered.slice(safePage * LIB_PAGE, safePage * LIB_PAGE + LIB_PAGE);
  useEffect(() => { setLibPage(0); }, [libQuery]); // jump back to page 1 on a new search

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

  // Build the encode-options payload shared by /start and the live /settings push.
  // In basic mode we still send `advanced: { rateControl }` so the basic CBR/VBR
  // toggle reaches the server's encode pipeline (which only reads from .advanced).
  const buildEncodePayload = () => {
    const payload = { resolution, bitrate, audioBitrate, audioChannels: parseInt(audioChannels, 10), fps: parseInt(fps, 10), order, fit: videoFit };
    payload.advanced = advancedMode ? adv : { rateControl };
    return payload;
  };

  const goLive = async () => {
    if (!streamKey.trim()) { notify?.('Add your stream key in Settings', 'error'); setDrawerOpen(true); return; }
    const payload = { rtmpUrl, streamKey, ...buildEncodePayload() };
    await call(() => api.post('/api/queue/start', payload), 'Go live');
    notify?.('Going live');
  };
  const stop = () => call(() => api.post('/api/queue/stop'), 'Stop');
  const skipNext = () => call(() => api.post('/api/queue/next'), 'Next');

  // While streaming, push setting changes to the server so they apply at the
  // next file boundary — no reconnect to the RTMP ingest. Debounced so dragging
  // a slider doesn't spam the endpoint.
  useEffect(() => {
    if (!streaming) return;
    const t = setTimeout(() => {
      api.post('/api/queue/settings', buildEncodePayload()).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, resolution, bitrate, rateControl, audioBitrate, audioChannels, fps, order, videoFit, advancedMode, adv]);

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
            {streaming && <NowPlaying status={streamStatus} currentFile={queue.currentFile} nextTrack={nextTrack} onStop={stop} onNext={skipNext} />}

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
              {libPageItems.map((path) => (
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
            </div>
            {libPageCount > 1 && (
              <div className="lib-pager">
                <button className="btn btn-secondary btn-small" disabled={safePage <= 0} onClick={() => setLibPage(safePage - 1)}>‹ Prev</button>
                <span className="muted">
                  {safePage * LIB_PAGE + 1}–{Math.min((safePage + 1) * LIB_PAGE, libFiltered.length)} of {libFiltered.length} · page {safePage + 1}/{libPageCount}
                </span>
                <button className="btn btn-secondary btn-small" disabled={safePage >= libPageCount - 1} onClick={() => setLibPage(safePage + 1)}>Next ›</button>
              </div>
            )}
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
                    <option value="fit">Fit (bars)</option><option value="stretch">Stretch</option><option value="crop">Crop to fill</option>
                  </select>
                </label>
                <label className="field">Frame rate
                  <select value={fps} onChange={(e) => save('rs_fps', e.target.value, setFps)}>
                    <option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option>
                  </select>
                </label>
                <label className="field">Audio channels
                  <select value={audioChannels} onChange={(e) => save('rs_ac', e.target.value, setAudioChannels)}>
                    <option value="2">Stereo</option><option value="1">Mono</option>
                  </select>
                </label>
                <label className="field">Video bitrate
                  <input list="dl-vb" value={bitrate} onChange={(e) => save('rs_vb', e.target.value, setBitrate)} placeholder="e.g. 1.2M or 1500k" />
                  <datalist id="dl-vb">{['1M','1.2M','1.4M','1.6M','1.8M','2M','3M','4M','5M','6M'].map((b) => <option key={b} value={b} />)}</datalist>
                </label>
                {!advancedMode && (
                  <label className="field">Rate control
                    <select value={rateControl} onChange={(e) => save('rs_rc', e.target.value, setRateControl)}>
                      <option value="cbr">CBR (steady)</option>
                      <option value="vbr">VBR (capped)</option>
                    </select>
                  </label>
                )}
                <label className="field">Audio bitrate
                  <select value={audioBitrate} onChange={(e) => save('rs_ab', e.target.value, setAudioBitrate)}>{['64k','96k','112k','128k','160k','192k','256k','320k'].map((b) => <option key={b} value={b}>{b}</option>)}</select>
                </label>
                <label className="field">Playback order
                  <select value={order} onChange={(e) => save('rs_order', e.target.value, setOrder)}>
                    <option value="shuffle">Shuffle</option><option value="sequential">In order (A→Z)</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="drawer-section">
              <div className="lib-head">
                <h3>Advanced encoder</h3>
                <label className="adv-toggle">
                  <input type="checkbox" checked={advancedMode} onChange={(e) => toggleAdvanced(e.target.checked)} />
                  Advanced mode
                </label>
              </div>
              {advancedMode ? (
                <>
                  <p className="hint">Overrides the platform-safe defaults. Blank Max rate / Buf size = derived from the bitrate. Bad values can break the encode (every file gets skipped), so reset if unsure.</p>
                  <div className="grid-2">
                    <label className="field">Preset
                      <input list="dl-preset" value={adv.preset} onChange={(e) => setAdvField('preset', e.target.value)} />
                    </label>
                    <label className="field">Profile
                      <input list="dl-profile" value={adv.profile} onChange={(e) => setAdvField('profile', e.target.value)} placeholder="high / main / none" />
                    </label>
                    <label className="field">Tune
                      <input list="dl-tune" value={adv.tune} onChange={(e) => setAdvField('tune', e.target.value)} placeholder="(none)" />
                    </label>
                    <label className="field">Level
                      <input value={adv.level} onChange={(e) => setAdvField('level', e.target.value)} placeholder="(auto) e.g. 4.1" />
                    </label>
                    <label className="field">Rate control
                      <select value={adv.rateControl} onChange={(e) => setAdvField('rateControl', e.target.value)}>
                        <option value="cbr">CBR</option><option value="vbr">VBR (capped)</option><option value="crf">CRF</option>
                      </select>
                    </label>
                    <label className="field">CRF
                      <input type="number" min="0" max="51" value={adv.crf} onChange={(e) => setAdvField('crf', e.target.value)} />
                    </label>
                    <label className="field">Max rate
                      <input value={adv.maxrate} onChange={(e) => setAdvField('maxrate', e.target.value)} placeholder="= bitrate" />
                    </label>
                    <label className="field">Buf size
                      <input value={adv.bufsize} onChange={(e) => setAdvField('bufsize', e.target.value)} placeholder="= 2× bitrate" />
                    </label>
                    <label className="field">Keyframe (sec)
                      <input type="number" min="0.5" step="0.5" value={adv.gopSeconds} onChange={(e) => setAdvField('gopSeconds', e.target.value)} />
                    </label>
                    <label className="field">B-frames
                      <input type="number" min="0" value={adv.bframes} onChange={(e) => setAdvField('bframes', e.target.value)} />
                    </label>
                    <label className="field">Scene-cut
                      <input type="number" value={adv.sceneCut} onChange={(e) => setAdvField('sceneCut', e.target.value)} />
                    </label>
                    <label className="field">Pixel format
                      <input list="dl-pixfmt" value={adv.pixfmt} onChange={(e) => setAdvField('pixfmt', e.target.value)} />
                    </label>
                    <label className="field">Audio codec
                      <input list="dl-acodec" value={adv.audioCodec} onChange={(e) => setAdvField('audioCodec', e.target.value)} />
                    </label>
                    <label className="field">Audio rate
                      <input list="dl-arate" value={adv.audioSampleRate} onChange={(e) => setAdvField('audioSampleRate', e.target.value)} />
                    </label>
                  </div>
                  <label className="field">Extra ffmpeg args <span className="muted">(output options — power user)</span>
                    <input value={adv.extraArgs} onChange={(e) => setAdvField('extraArgs', e.target.value)} placeholder={'-x264-params "keyint=60:scenecut=0" -aq-mode 3'} />
                  </label>
                  <button className="btn btn-secondary btn-small" onClick={resetAdv}>Reset to platform defaults</button>
                  <datalist id="dl-preset">{['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow'].map((x) => <option key={x} value={x} />)}</datalist>
                  <datalist id="dl-profile">{['baseline','main','high','high10','none'].map((x) => <option key={x} value={x} />)}</datalist>
                  <datalist id="dl-tune">{['film','animation','grain','stillimage','fastdecode','zerolatency'].map((x) => <option key={x} value={x} />)}</datalist>
                  <datalist id="dl-pixfmt">{['yuv420p','yuv422p','yuv444p'].map((x) => <option key={x} value={x} />)}</datalist>
                  <datalist id="dl-acodec">{['aac'].map((x) => <option key={x} value={x} />)}</datalist>
                  <datalist id="dl-arate">{['44100','48000'].map((x) => <option key={x} value={x} />)}</datalist>
                </>
              ) : (
                <p className="hint">Off — using the platform-safe encode (x264 High, 2s keyframes, yuv420p, 48 kHz AAC) tuned for Twitch / Kick / AngelThump. Rate control honours the basic CBR/VBR toggle above.</p>
              )}
            </div>
          </aside>
        </>
      )}

      {showBrowser && <FolderBrowser onSelectFolder={(p) => { setFolderPath(p); setShowBrowser(false); }} onClose={() => setShowBrowser(false)} />}
    </div>
  );
}

export default QueueView;
