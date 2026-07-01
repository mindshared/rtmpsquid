import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { ContinuousStream } from './continuousStream.js';
import { config } from './config.js';
import { findSidecarSubtitles, resolveSubtitleToTemp, removeTempSubtitle, clampFontSize, subtitlesFilterAvailable } from './subtitles.js';
import { loadState, saveState, saveStateNow } from './store.js';

/**
 * One auto-filling queue. It draws random movies from a library folder, keeps
 * itself topped up (refills when fewer than config.queueMin remain), and plays
 * straight through forever. No playlists, no modes — VLC-simple.
 */
export class StreamManager {
  constructor(io) {
    this.io = io;
    this.library = { folder: null, files: [] }; // the pool of all movies
    this.excluded = new Set();                    // library paths the user parked (X) — skipped by auto-fill
    this.queue = [];                              // upcoming list (queue[0] = now playing)
    this.currentFile = null;
    this.stream = null;                           // ContinuousStream | null
    this.rtmpUrl = null;
    this.paused = false;                          // true after pauseQueue() until resume/stop
    this.resumePoint = null;                      // { file, offset } captured at pause
    // Last skip/crash, kept so the dashboard can show a recovery card and offer to
    // resume the movie at the point it stopped. { reason, file, path, offset,
    // message, at, streaming }. Cleared on a fresh start/stop or explicit dismiss.
    this.lastIncident = null;
    this.lastRtmpUrl = null;                      // remembered for resume
    this.lastOptions = null;                      // remembered encode options for resume
    this.autoRestart = true;                      // mirrors the user's auto-restart setting
    this.order = 'shuffle';                        // 'shuffle' | 'sequential'
    this._seqIndex = 0;                            // cursor into the sorted library for sequential play
    this.minMovieMB = config.minMovieBytes / (1024 * 1024); // smallest file allowed in the library
    this._durations = new Map(); // absolute path -> { seconds: number|null, sig: 'mtimeMs:size' } (ffprobe cache)

    // Per-title burned-in subtitles: absolute video path -> { kind:'file', path,
    // label, safePath }. Keyed by path so the choice survives reorder/refill and a
    // file queued twice shares it. safePath is a hashed temp copy fed to ffmpeg.
    this.subtitles = new Map();
    this.subtitleFontSize = clampFontSize(process.env.SUBTITLE_FONT_SIZE, 20); // global on-screen size

    this._liveOffset = 0;         // last-known position (s) in the current movie, for crash-resume
    this._persistTimer = null;    // heartbeat that keeps _liveOffset + state fresh while streaming
    this._restoring = false;      // suppress persistence while restore() rebuilds state

    // NB: the default library is loaded (or the saved state restored) by
    // restore(), called once from the server boot — not here — so a persisted
    // queue/settings isn't clobbered by a fresh auto-load.
  }

  // ---- persistence ---------------------------------------------------------

  // Everything worth surviving a restart. Subtitle picks keep their source path
  // (not the temp copy, which is regenerated on load). currentOffset lets an
  // auto-resume pick the movie back up near where it stopped.
  _snapshot() {
    return {
      version: 1,
      library: { folder: this.library.folder, minMovieMB: this.minMovieMB },
      excluded: [...this.excluded],
      order: this.order,
      autoRestart: this.autoRestart,
      subtitleFontSize: this.subtitleFontSize,
      subtitles: [...this.subtitles].map(([file, c]) => [file, { kind: c.kind, path: c.path, label: c.label }]),
      queue: [...this.queue],
      stream: {
        wasStreaming: !!this.stream,
        paused: this.paused,
        rtmpUrl: this.lastRtmpUrl,
        options: this.lastOptions,
        currentFile: this.currentFile,
        currentOffset: Math.max(0, Math.floor(this._liveOffset || 0)),
        resumePoint: this.resumePoint,
      },
      lastIncident: this.lastIncident,
    };
  }

  // Queue a debounced save of the current snapshot (no-op while restoring).
  _persist() {
    if (this._restoring) return;
    try { saveState(this._snapshot()); } catch { /* persistence is best-effort */ }
  }

  // While streaming, tick every few seconds to keep the remembered position
  // current so a crash/reboot can resume close to where it stopped.
  _startPersistHeartbeat() {
    if (this._persistTimer) return;
    this._persistTimer = setInterval(() => {
      if (!this.stream) return;
      try { this._liveOffset = this.stream.getResumeState().offset || 0; } catch {}
      this._persist();
    }, 5000);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  _stopPersistHeartbeat() {
    if (this._persistTimer) { clearInterval(this._persistTimer); this._persistTimer = null; }
  }

  // Load persisted state on boot and bring the app back to where it was: same
  // library, queue, parked files, subtitle picks and settings — and, if it was
  // live when it stopped, auto-resume the stream near the point it left off.
  async restore() {
    let st = null;
    try { st = loadState(); } catch {}
    this._restoring = true;
    try {
      // Library first (this rebuilds a fresh queue + clears subtitles), then we
      // overlay the saved queue/subtitles/settings on top.
      const folder = (st && st.library && st.library.folder) || config.libraryDir;
      const minMB = st && st.library && Number.isFinite(st.library.minMovieMB) ? st.library.minMovieMB : this.minMovieMB;
      if (folder) {
        try { await this.setLibrary(folder, minMB); } catch (e) { console.error('library load:', e.message); }
      }
      if (st) {
        this.excluded = new Set(Array.isArray(st.excluded) ? st.excluded : []);
        this.order = st.order === 'sequential' ? 'sequential' : 'shuffle';
        this.autoRestart = st.autoRestart !== false;
        this.subtitleFontSize = clampFontSize(st.subtitleFontSize, this.subtitleFontSize);
        // Restore the exact upcoming order (drop files that no longer exist).
        if (Array.isArray(st.queue) && st.queue.length) {
          this.queue = st.queue.filter((f) => { try { return fs.existsSync(f); } catch { return false; } });
        }
        // Re-resolve each subtitle pick to a fresh temp copy for the filtergraph.
        for (const [file, c] of Array.isArray(st.subtitles) ? st.subtitles : []) {
          if (c && c.kind === 'file' && c.path) {
            try {
              const safePath = resolveSubtitleToTemp(c.path);
              this.subtitles.set(file, { kind: 'file', path: c.path, label: c.label || 'Subtitles', safePath });
            } catch { /* subtitle source gone/unreadable — skip this pick */ }
          }
        }
        this.lastRtmpUrl = (st.stream && st.stream.rtmpUrl) || null;
        this.lastOptions = (st.stream && st.stream.options) || null;
        this.lastIncident = st.lastIncident || null;
        this.resumePoint = (st.stream && st.stream.resumePoint) || null;
        this.paused = !!(st.stream && st.stream.paused);
      }
    } finally {
      this._restoring = false;
    }

    this.io.emit('library:updated', this.getLibrary());
    this.io.emit('queue:updated', this.getQueue());

    // Auto-resume: if it was live when it stopped, reconnect to the same target
    // and pick the current movie back up near where it left off.
    if (st && st.stream && st.stream.wasStreaming && this.lastRtmpUrl && this.queue.length) {
      const cf = st.stream.currentFile;
      const off = Math.max(0, Math.floor(Number(st.stream.currentOffset) || 0));
      if (cf) {
        const idx = this.queue.indexOf(cf);
        if (idx > 0) this.queue.splice(idx, 1);
        if (idx !== 0) this.queue.unshift(cf);
      }
      const opts = { ...(this.lastOptions || {}), startTime: off || null };
      this.paused = false;
      this.resumePoint = null;
      try {
        await this.startQueue(this.lastRtmpUrl, opts);
        console.log(`auto-resumed stream${cf ? ` at ${path.basename(cf)} +${off}s` : ''}`);
      } catch (e) {
        console.error('auto-resume failed:', e.message);
      }
    }
    this._persist();
    return this.getQueue();
  }

  // Flush state to disk synchronously (called on shutdown). Sample the freshest
  // position first so a graceful restart resumes right where it left off.
  persistNow() {
    try {
      if (this.stream) { try { this._liveOffset = this.stream.getResumeState().offset || 0; } catch {} }
      saveStateNow(this._snapshot());
    } catch {}
  }

  // ---- library scan (async, depth-limited, symlink-safe) -------------------

  async scanFolderForVideos(folderPath, { recursive = true, minSizeBytes = 0 } = {}) {
    const results = [];
    const exts = new Set(config.videoExtensions);
    const walk = async (dir, depth) => {
      if (depth > config.scanMaxDepth) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue; // no symlink following (loops / escapes)
        if (entry.isDirectory()) { if (recursive) await walk(full, depth + 1); }
        else if (entry.isFile()) {
          if (!exts.has(path.extname(entry.name).toLowerCase())) continue;
          let st; try { st = await fsp.stat(full); } catch { continue; }
          if (st.size < minSizeBytes) continue;
          results.push(full);
        }
      }
    };
    await walk(folderPath, 0);
    return results;
  }

  async setLibrary(folder, minSizeMB = this.minMovieMB) {
    const mb = Number.isFinite(minSizeMB) && minSizeMB >= 0 ? minSizeMB : this.minMovieMB;
    this.minMovieMB = mb;
    const files = await this.scanFolderForVideos(folder, { recursive: true, minSizeBytes: Math.round(mb * 1024 * 1024) });
    this.library = { folder, files };
    // Build a fresh queue from the new library (reset the sequential cursor too).
    this.queue = [];
    this._seqIndex = 0;
    this._clearAllSubtitles(); // picks referenced the old library's files

    this._refill();
    this._persist();
    this.io.emit('library:updated', this.getLibrary());
    this.io.emit('queue:updated', this.getQueue());
    // Probe durations in the background; emits library/queue updates as they fill.
    this._ensureDurations(this.library.files).catch(() => {});
    return this.getQueue();
  }

  // Full library list (for the browseable side panel).
  getLibrary() {
    return {
      folder: this.library.folder,
      files: this.library.files,
      minMovieMB: this.minMovieMB,
      durations: this._durationsFor(this.library.files),
      excluded: [...this.excluded], // parked files the auto-queue won't pull
    };
  }

  // Movies eligible for auto-fill: the library minus anything the user parked
  // with the X button. Parking every file yields an empty pool, in which case
  // the queue simply can't top up (same effect as an empty library).
  _autoPool() {
    return this.excluded.size ? this.library.files.filter((f) => !this.excluded.has(f)) : this.library.files;
  }

  // Park (excluded=true) or un-park a library file. Parking also drops any
  // not-yet-played copies already sitting in the queue, but keeps the
  // currently-playing one so we never cut a movie off mid-play. Un-parking just
  // makes the file eligible for future refills again.
  setExcluded(file, excluded = true) {
    if (!file) return this.getLibrary();
    if (excluded) {
      this.excluded.add(file);
      const head = this.stream ? this.currentFile : null; // keep the now-playing copy
      this.queue = this.queue.filter((f, i) => f !== file || (i === 0 && f === head));
      this._refill();
      this.io.emit('queue:updated', this.getQueue());
    } else if (!this.excluded.delete(file)) {
      return this.getLibrary(); // wasn't parked — nothing changed, skip the broadcast
    }
    this._persist();
    this.io.emit('library:updated', this.getLibrary());
    return this.getLibrary();
  }

  // ---- movie durations (ffprobe, cached by mtime+size) ---------------------

  // Build a { path: seconds } map from the cache for the given files (only
  // includes ones already probed; unknown ones are simply absent).
  _durationsFor(files) {
    const out = {};
    for (const f of files || []) {
      const c = this._durations.get(f);
      if (c && c.seconds != null) out[f] = c.seconds;
    }
    return out;
  }

  // Probe one file's duration (seconds), reusing the cache unless the file
  // changed (mtime/size). Never throws; returns null if it can't be read.
  _probeDuration(file) {
    return new Promise((resolve) => {
      let st;
      try { st = fs.statSync(file); } catch { return resolve(null); }
      const sig = `${st.mtimeMs}:${st.size}`;
      const cached = this._durations.get(file);
      if (cached && cached.sig === sig) return resolve(cached.seconds);
      let out = '';
      let proc;
      try {
        proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
          '-of', 'default=nokey=1:noprint_wrappers=1', file], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { return resolve(cached?.seconds ?? null); }
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.on('error', () => resolve(cached?.seconds ?? null));
      proc.on('exit', () => {
        const n = parseFloat(out.trim());
        const seconds = Number.isFinite(n) && n > 0 ? n : null;
        this._durations.set(file, { seconds, sig });
        resolve(seconds);
      });
    });
  }

  // Fill in durations for a set of files in the background (bounded concurrency),
  // emitting updates as results stream in so the UI fills progressively even for
  // a large library. Fire-and-forget; cached files resolve instantly.
  async _ensureDurations(files) {
    const list = [...new Set((files || []).filter(Boolean))];
    if (!list.length) return;
    let idx = 0;
    let newly = 0;
    const emit = () => {
      this.io.emit('library:updated', this.getLibrary());
      this.io.emit('queue:updated', this.getQueue());
    };
    const worker = async () => {
      while (idx < list.length) {
        const f = list[idx++];
        const had = this._durations.get(f);
        const sec = await this._probeDuration(f);
        if (sec != null && (!had || had.seconds !== sec)) {
          newly += 1;
          if (newly % 24 === 0) emit(); // stream partial results for big libraries
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]); // 4-way concurrency
    if (newly) emit();
  }

  // ---- queue management ----------------------------------------------------

  _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Library in a stable, human order (natural sort so "Ep 2" precedes "Ep 10").
  _sortedLibrary() {
    return [...this.library.files].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }

  // Keep the queue topped up: when fewer than queueMin remain, add movies up to
  // queueTarget — random (no near-term repeats) or in library order, per this.order.
  _refill() {
    if (!this.library.files.length) return;
    if (this.queue.length >= config.queueMin) return;

    const pool = this._autoPool();
    if (!pool.length) return; // every movie is parked — nothing to pull

    if (this.order === 'sequential') {
      const sorted = this._sortedLibrary().filter((f) => !this.excluded.has(f));
      while (this.queue.length < config.queueTarget) {
        this.queue.push(sorted[this._seqIndex % sorted.length]);
        this._seqIndex = (this._seqIndex + 1) % sorted.length;
      }
      return;
    }

    const inUse = new Set([...this.queue, ...(this.currentFile ? [this.currentFile] : [])]);
    for (const f of this._shuffle(pool.filter((f) => !inUse.has(f)))) {
      if (this.queue.length >= config.queueTarget) break;
      this.queue.push(f);
    }
    // Small pool (fewer unique files than queueTarget): allow replays so the
    // queue still fills and loops, consistent with the sequential branch.
    while (this.queue.length < config.queueTarget) {
      const before = this.queue.length;
      for (const f of this._shuffle(pool)) {
        if (this.queue.length >= config.queueTarget) break;
        this.queue.push(f);
      }
      if (this.queue.length === before) break; // safety: no progress (can't happen with a non-empty pool)
    }
  }

  getQueue() {
    // Per-movie durations for the queued files, plus the queue's known total.
    const durations = this._durationsFor(this.queue);
    let totalSeconds = 0;
    let totalKnown = this.queue.length > 0;
    for (const f of this.queue) {
      const c = this._durations.get(f);
      if (c && c.seconds != null) totalSeconds += c.seconds;
      else totalKnown = false;
    }
    return {
      library: this.library.folder,
      libraryCount: this.library.files.length,
      files: this.queue,
      currentFile: this.currentFile ? path.basename(this.currentFile) : null,
      streaming: !!this.stream,
      streamId: this.stream?.id || null,
      rtmpUrl: this.rtmpUrl,
      minMovieMB: this.minMovieMB,
      paused: this.paused,
      canResume: this.paused && !!this.resumePoint,
      resumeFile: this.paused && this.resumePoint?.file ? path.basename(this.resumePoint.file) : null,
      resumeOffset: this.paused && this.resumePoint ? Math.round(this.resumePoint.offset || 0) : null,
      autoRestart: this.autoRestart,
      durations, // { absolutePath: seconds } for the queued files
      totalSeconds: Math.round(totalSeconds), // sum of known queued durations
      totalKnown, // false while some queued durations are still being probed
      subtitles: this._subtitleSummary(), // { absolutePath: { label } } for titles with burned-in subs
      subtitleFontSize: this.subtitleFontSize, // global on-screen subtitle size
      lastIncident: this.lastIncident, // last skip/crash for the recovery card (or null)
    };
  }

  reshuffle() {
    // Fresh random pull (keeps the currently-playing track at the front).
    this.queue = this.stream && this.currentFile ? [this.currentFile] : [];
    this._refill();
    this._persist();
    this.io.emit('queue:updated', this.getQueue());
    return this.getQueue();
  }

  addToQueue(file, index = null) {
    if (index == null || Number.isNaN(index) || index < 0 || index > this.queue.length) this.queue.push(file);
    else this.queue.splice(index, 0, file);
    this._ensureDurations([file]).catch(() => {}); // probe it if not already cached
    this._persist();
    this.io.emit('queue:updated', this.getQueue());
    return this.getQueue();
  }

  removeFromQueue(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.queue.length) return this.getQueue();
    this.queue.splice(index, 1);
    this._refill();
    this._persist();
    this.io.emit('queue:updated', this.getQueue());
    return this.getQueue();
  }

  reorderQueue(from, to) {
    from = Number(from); to = Number(to);
    const n = this.queue.length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to ||
        from < 0 || from >= n || to < 0 || to >= n) return this.getQueue();
    const [m] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, m);
    this._persist();
    this.io.emit('queue:updated', this.getQueue());
    return this.getQueue();
  }

  // ---- per-title subtitles -------------------------------------------------

  // Resolver handed to ContinuousStream: returns the burn-in info for a content
  // file at feed time, or null. Reads the live map + global size, so a choice
  // made mid-stream applies when that title next starts.
  _subtitleForFeeder(file) {
    const choice = this.subtitles.get(file);
    if (!choice || !choice.safePath) return null;
    return { safePath: choice.safePath, fontSize: this.subtitleFontSize };
  }

  // What the picker shows for a file: the current selection, the global font size,
  // and the auto-detected sidecar options in/near its folder.
  getSubtitleOptions(file) {
    const cur = this.subtitles.get(file) || null;
    return {
      file,
      fontSize: this.subtitleFontSize,
      current: cur ? { kind: cur.kind, path: cur.path, label: cur.label } : null,
      options: findSidecarSubtitles(file),
      supported: subtitlesFilterAvailable(), // false ⇒ this ffmpeg can't burn subs in
    };
  }

  // Set (choice = { kind:'file', path, label }) or clear (choice = null) the
  // burned-in subtitle for one title, and optionally update the global font size.
  // `changeChoice=false` leaves the current pick untouched (a font-size-only
  // update). The choice is copied to a safe temp path immediately so feed time
  // stays cheap and the filtergraph never has to escape an awkward path. Applies
  // when the title next starts (we don't interrupt a track that's already playing).
  setSubtitle(file, choice, fontSize, changeChoice = true) {
    if (fontSize !== undefined && fontSize !== null && fontSize !== '') {
      this.subtitleFontSize = clampFontSize(fontSize, this.subtitleFontSize);
    }
    if (changeChoice) {
      const prev = this.subtitles.get(file);
      if (!choice) {
        this.subtitles.delete(file);
      } else if (choice.kind === 'file' && choice.path) {
        let safePath;
        try {
          safePath = resolveSubtitleToTemp(choice.path);
        } catch (e) {
          throw Object.assign(new Error(`Subtitle not readable: ${e.message}`), { status: 400 });
        }
        this.subtitles.set(file, { kind: 'file', path: choice.path, label: choice.label || 'Subtitles', safePath });
      }
      // Drop the previous temp copy if it's no longer referenced by this title.
      if (prev && prev.safePath && prev.safePath !== this.subtitles.get(file)?.safePath) {
        removeTempSubtitle(prev.safePath);
      }
      // If we just changed the subtitle for the movie that's playing RIGHT NOW,
      // apply it live: re-feed the current file at its current position so the
      // new burn-in (or its removal) takes effect immediately. Burned-in subs
      // can't be toggled without re-encoding, so this is a brief (~1-2s) blip,
      // no RTMP reconnect — same mechanism as a live seek.
      if (this.stream && file && file === this.currentFile) {
        try {
          const at = Math.max(0, Math.floor(this.stream.getResumeState().offset || 0));
          this.stream.seekCurrent(at);
          this._liveOffset = at;
        } catch { /* slate / not seekable — the pick still applies next start */ }
      }
    }
    this._persist();
    this.io.emit('queue:updated', this.getQueue());
    return this.getQueue();
  }

  // Forget every per-title subtitle and clean up its temp copies (called when the
  // library is replaced, so stale picks for gone files don't linger).
  _clearAllSubtitles() {
    for (const choice of this.subtitles.values()) removeTempSubtitle(choice.safePath);
    this.subtitles.clear();
  }

  // Light map of the active picks for the client ({ path: { label } }), so the
  // queue can flag which titles carry subtitles without shipping temp paths.
  _subtitleSummary() {
    const out = {};
    for (const [file, c] of this.subtitles) out[file] = { label: c.label };
    return out;
  }

  // ---- streaming -----------------------------------------------------------

  _attachEvents(cs) {
    cs.on('progress', (d) => {
      // Remember where we are in the current movie so a crash/reboot can resume
      // near this point (the heartbeat also samples it every few seconds).
      if (typeof d.filePositionSec === 'number') this._liveOffset = d.filePositionSec;
      this.io.emit('stream:progress', d);
    });
    cs.on('ffmpeglog', (d) => this.io.emit('stream:ffmpeg', d));
    cs.on('standby', (d) => this.io.emit('stream:standby', d));
    cs.on('reconnecting', (d) => this.io.emit('stream:reconnecting', d));
    cs.on('fileskipped', (d) => {
      // Stream keeps playing (the next file). Remember the skip so the card can
      // offer to re-queue that movie (optionally at a chosen time).
      this._recordIncident({ reason: 'skipped', file: d.file, path: d.path, offset: d.offset || 0, message: d.message, streaming: true });
      this.io.emit('stream:fileskipped', d);
    });
    cs.on('error', (d) => {
      // Terminal crash (auto-restart off) — the stream is down. Remember where the
      // movie was so the card can offer "Resume {file} at {time}".
      this._recordIncident({ reason: 'error', file: d.file, path: d.path, offset: d.offset || 0, message: d.error, streaming: false });
      this._stopPersistHeartbeat();
      this._liveOffset = Math.max(0, Math.floor(Number(d.offset) || 0));
      this.stream = null; this.currentFile = null; this.rtmpUrl = null;
      this._persist(); // remember the crash point so an auto-resume can pick it up
      this.io.emit('stream:error', d);
      this.io.emit('queue:updated', this.getQueue());
    });
    cs.on('stopped', () => {
      this.stream = null;
      this.currentFile = null;
      // A pause stops the stream too; let pauseQueue() own the UI signal in that
      // case so the client shows "Paused" rather than a full stop.
      if (this.paused) { this.io.emit('queue:updated', this.getQueue()); return; }
      this._stopPersistHeartbeat();
      this._liveOffset = 0;
      this.rtmpUrl = null;
      this._persist();
      this.io.emit('stream:stopped', {});
      this.io.emit('queue:updated', this.getQueue());
    });
  }

  async startQueue(rtmpUrl, options = {}) {
    if (this.stream) throw Object.assign(new Error('Already streaming'), { status: 400 });
    // Apply the requested playback order for future refills. Preserve an existing
    // (possibly user-curated) queue across stop/start — stopping no longer wipes
    // or reshuffles the playlist; only an empty queue is built fresh, and the
    // explicit Shuffle button is the way to deliberately re-randomise.
    this.order = options.order === 'sequential' ? 'sequential' : 'shuffle';
    if (!this.queue.length) this._seqIndex = 0;
    this._refill();
    if (!this.queue.length) throw Object.assign(new Error('Queue is empty — set a library folder with movies'), { status: 400 });

    // Remember connection + options so pause/resume and auto-restart can rebuild.
    this.lastRtmpUrl = rtmpUrl;
    this.lastOptions = { ...options };
    this.autoRestart = options.autoRestart !== false;
    this.paused = false;
    this.lastIncident = null; // a fresh start clears any stale recovery card

    const streamId = randomUUID();
    let first = true;

    // Provider: play queue[0]; when it finishes, drop it, refill, play the new
    // head. The queue therefore drains as it plays and tops itself back up.
    const nextFile = () => {
      if (!first && this.currentFile) {
        const i = this.queue.indexOf(this.currentFile);
        if (i >= 0) this.queue.splice(i, 1);
      }
      first = false;
      this._refill();
      if (!this.queue.length) { this.currentFile = null; this.io.emit('queue:updated', this.getQueue()); return null; }
      this.currentFile = this.queue[0];
      this.io.emit('queue:updated', this.getQueue());
      return this.currentFile;
    };

    const cs = new ContinuousStream({ id: streamId, rtmpUrl, options, nextFile, subtitleFor: (f) => this._subtitleForFeeder(f) });
    this.rtmpUrl = rtmpUrl;
    this._attachEvents(cs);
    this.stream = cs;
    this._liveOffset = Number.isFinite(Number(options.startTime)) ? Math.max(0, Number(options.startTime)) : 0;
    await cs.start();
    this._startPersistHeartbeat();
    this._persist();
    this.io.emit('queue:updated', this.getQueue());
    return { streamId };
  }

  // Explicit stop: tear the stream down but KEEP the playlist as-is (no wipe, no
  // reshuffle) and forget any pause/resume point — Stop always wins over
  // auto-restart. The queue is left intact so Go Live picks up the same list.
  async stopQueue() {
    this.paused = false;
    this.resumePoint = null;
    this.lastIncident = null; // explicit stop clears the recovery card
    this._stopPersistHeartbeat();
    this._liveOffset = 0;
    if (this.stream) { await this.stream.stop(); this.stream = null; }
    this.currentFile = null;
    this.rtmpUrl = null;
    this._persist();
    this.io.emit('queue:updated', this.getQueue());
  }

  // Pause: capture the current movie + position, then take the broadcast offline
  // (we disconnect from the platform). The queue and resume point are kept so
  // resumeQueue() can reconnect and pick up where we left off.
  async pauseQueue() {
    if (!this.stream) throw Object.assign(new Error('Not streaming'), { status: 400 });
    const state = this.stream.getResumeState(); // { file, offset }
    this.resumePoint = state;
    // Set paused before stopping so the stream's own 'stopped' event is treated
    // as a pause (not a full stop) by the handler above.
    this.paused = true;
    this._stopPersistHeartbeat();
    this._liveOffset = state.offset || 0;
    await this.stream.stop();
    this.stream = null;
    this.rtmpUrl = null;
    this._persist();
    const file = state.file ? path.basename(state.file) : null;
    this.io.emit('stream:paused', { file, offset: Math.round(state.offset || 0) });
    this.io.emit('queue:updated', this.getQueue());
    return { paused: true, file, offset: Math.round(state.offset || 0) };
  }

  // Resume a paused stream: reconnect to the same destination and start the
  // remembered file at the remembered offset. An explicit offset (seconds)
  // overrides where we pick up — that's the editable "Resume at H:M:S" field.
  async resumeQueue(offsetOverride) {
    if (this.stream) throw Object.assign(new Error('Already streaming'), { status: 400 });
    if (!this.paused || !this.lastRtmpUrl) throw Object.assign(new Error('Nothing to resume'), { status: 400 });
    const rp = this.resumePoint || {};
    // Make sure the paused movie is the head of the queue so we resume it (not
    // whatever happens to be first), then seek into it on the first feed.
    if (rp.file) {
      const idx = this.queue.indexOf(rp.file);
      if (idx > 0) this.queue.splice(idx, 1);
      if (idx !== 0) this.queue.unshift(rp.file);
    }
    const off = offsetOverride != null && Number.isFinite(Number(offsetOverride)) ? Math.max(0, Number(offsetOverride)) : rp.offset;
    const opts = { ...(this.lastOptions || {}), startTime: off ? Math.max(0, Math.floor(off)) : null };
    this.paused = false;
    this.resumePoint = null;
    return this.startQueue(this.lastRtmpUrl, opts);
  }

  // Live-toggle the on-screen title overlay (instant — see
  // ContinuousStream.setShowTitle). Remembered in lastOptions so a pause/resume
  // keeps the choice, and broadcast so every connected dashboard updates.
  setShowTitle(show) {
    if (!this.stream) throw Object.assign(new Error('Not streaming'), { status: 400 });
    const showTitle = this.stream.setShowTitle(show);
    this.lastOptions = { ...(this.lastOptions || {}), showTitle };
    this._persist();
    this.io.emit('stream:title', { showTitle });
    return { showTitle };
  }

  // Skip the currently-playing file and advance to the next one.
  skipCurrent() {
    if (!this.stream) throw Object.assign(new Error('Not streaming'), { status: 400 });
    return { success: this.stream.skip() };
  }

  // ---- seek + incident recovery --------------------------------------------

  // Jump the currently-playing movie to an exact position (seconds), live — no
  // reconnect. Used by the "Jump to H:M:S" control.
  seekTo(offset) {
    if (!this.stream) throw Object.assign(new Error('Not streaming'), { status: 400 });
    const secs = Math.max(0, Math.floor(Number(offset) || 0));
    const success = this.stream.seekCurrent(secs);
    if (!success) throw Object.assign(new Error('Can only seek during a movie (not the standby slate)'), { status: 400 });
    this._liveOffset = secs;
    this._persist();
    return { success, offset: secs };
  }

  // Remember a skip/crash and push it to the dashboard.
  _recordIncident({ reason, file, path: filePath, offset, message, streaming }) {
    this.lastIncident = {
      reason,
      file: file || (filePath ? path.basename(filePath) : null),
      path: filePath || null,
      offset: Math.max(0, Math.floor(Number(offset) || 0)),
      message: message ? String(message).slice(0, 300) : null,
      at: Date.now(),
      streaming: !!streaming,
    };
    this._persist();
  }

  // Dismiss the recovery card.
  clearIncident() {
    this.lastIncident = null;
    this._persist();
    this.io.emit('queue:updated', this.getQueue());
    return this.getQueue();
  }

  // Resume the last-crashed movie: put it at the front and start the stream at the
  // requested offset (defaults to where it crashed), reusing the remembered
  // destination + encode options. Only valid when stopped — while live, the
  // dashboard uses seekTo / re-queue instead.
  async recoverIncident(offset) {
    if (this.stream) throw Object.assign(new Error('Already streaming — use seek or re-queue instead'), { status: 400 });
    const inc = this.lastIncident;
    if (!inc || !inc.path) throw Object.assign(new Error('Nothing to recover'), { status: 400 });
    if (!this.lastRtmpUrl) throw Object.assign(new Error('No remembered destination — press Go Live'), { status: 400 });
    const file = inc.path;
    const idx = this.queue.indexOf(file);
    if (idx > 0) this.queue.splice(idx, 1);
    if (idx !== 0) this.queue.unshift(file);
    const secs = offset != null && Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : inc.offset;
    const opts = { ...(this.lastOptions || {}), startTime: secs || null };
    this.lastIncident = null;
    this.paused = false;
    this.resumePoint = null;
    return this.startQueue(this.lastRtmpUrl, opts);
  }

  // Live settings update — applies at the next file boundary so the RTMP
  // connection stays up. Connection params (rtmpUrl/streamKey) are intentionally
  // not accepted here; changing destination needs a stop/start.
  updateSettings(options = {}) {
    if (!this.stream) throw Object.assign(new Error('Not streaming'), { status: 400 });
    if (options.order === 'sequential' || options.order === 'shuffle') this.order = options.order;
    if (options.autoRestart !== undefined) this.autoRestart = options.autoRestart !== false;
    // Keep remembered options current so a later pause/resume uses the latest.
    this.lastOptions = { ...(this.lastOptions || {}), ...options };
    this._persist();
    this.stream.updateOptions(options);
    return { applied: true, appliesAtNextTrack: true };
  }

  getActiveStreams() {
    return this.stream ? [this.stream.getStatus()] : [];
  }

  // Live ffmpeg pids ([{ role, pid }]) for the resource sampler, or [] when idle.
  getProcPids() {
    return this.stream ? this.stream.getProcs() : [];
  }

  async stopAllStreams() {
    this._stopPersistHeartbeat();
    if (this.stream) { await this.stream.stop().catch(() => {}); this.stream = null; }
    this._clearAllSubtitles();
  }
}
