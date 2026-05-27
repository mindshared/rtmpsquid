import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { ContinuousStream } from './continuousStream.js';
import { config } from './config.js';

/**
 * One auto-filling queue. It draws random movies from a library folder, keeps
 * itself topped up (refills when fewer than config.queueMin remain), and plays
 * straight through forever. No playlists, no modes — VLC-simple.
 */
export class StreamManager {
  constructor(io) {
    this.io = io;
    this.library = { folder: null, files: [] }; // the pool of all movies
    this.queue = [];                              // upcoming list (queue[0] = now playing)
    this.currentFile = null;
    this.stream = null;                           // ContinuousStream | null
    this.rtmpUrl = null;
    this.order = 'shuffle';                        // 'shuffle' | 'sequential'
    this._seqIndex = 0;                            // cursor into the sorted library for sequential play
    this.minMovieMB = config.minMovieBytes / (1024 * 1024); // smallest file allowed in the library

    // Auto-load the default library on boot so it "just plays" out of the box.
    if (config.libraryDir) this.setLibrary(config.libraryDir).catch((e) => console.error('library load:', e.message));
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
    this._refill();
    this.io.emit('library:updated', this.getLibrary());
    this.io.emit('queue:updated', this.getQueue());
    return this.getQueue();
  }

  // Full library list (for the browseable side panel).
  getLibrary() {
    return { folder: this.library.folder, files: this.library.files, minMovieMB: this.minMovieMB };
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

    if (this.order === 'sequential') {
      const sorted = this._sortedLibrary();
      while (this.queue.length < config.queueTarget) {
        this.queue.push(sorted[this._seqIndex % sorted.length]);
        this._seqIndex = (this._seqIndex + 1) % sorted.length;
      }
      return;
    }

    const inUse = new Set([...this.queue, ...(this.currentFile ? [this.currentFile] : [])]);
    for (const f of this._shuffle(this.library.files.filter((f) => !inUse.has(f)))) {
      if (this.queue.length >= config.queueTarget) break;
      this.queue.push(f);
    }
    // Small library (fewer unique files than queueTarget): allow replays so the
    // queue still fills and loops, consistent with the sequential branch.
    while (this.queue.length < config.queueTarget) {
      const before = this.queue.length;
      for (const f of this._shuffle(this.library.files)) {
        if (this.queue.length >= config.queueTarget) break;
        this.queue.push(f);
      }
      if (this.queue.length === before) break; // safety: no progress (can't happen with a non-empty library)
    }
  }

  getQueue() {
    return {
      library: this.library.folder,
      libraryCount: this.library.files.length,
      files: this.queue,
      currentFile: this.currentFile ? path.basename(this.currentFile) : null,
      streaming: !!this.stream,
      streamId: this.stream?.id || null,
      rtmpUrl: this.rtmpUrl,
      minMovieMB: this.minMovieMB,
    };
  }

  reshuffle() {
    // Fresh random pull (keeps the currently-playing track at the front).
    this.queue = this.stream && this.currentFile ? [this.currentFile] : [];
    this._refill();
    this.io.emit('queue:updated', this.getQueue());
    return this.getQueue();
  }

  addToQueue(file, index = null) {
    if (index == null || Number.isNaN(index) || index < 0 || index > this.queue.length) this.queue.push(file);
    else this.queue.splice(index, 0, file);
    this.io.emit('queue:updated', this.getQueue());
    return this.getQueue();
  }

  removeFromQueue(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.queue.length) return this.getQueue();
    this.queue.splice(index, 1);
    this._refill();
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
    this.io.emit('queue:updated', this.getQueue());
    return this.getQueue();
  }

  // ---- streaming -----------------------------------------------------------

  _attachEvents(cs) {
    cs.on('progress', (d) => this.io.emit('stream:progress', d));
    cs.on('standby', (d) => this.io.emit('stream:standby', d));
    cs.on('reconnecting', (d) => this.io.emit('stream:reconnecting', d));
    cs.on('fileskipped', (d) => this.io.emit('stream:fileskipped', d));
    cs.on('error', (d) => { this.stream = null; this.currentFile = null; this.rtmpUrl = null; this.io.emit('stream:error', d); this.io.emit('queue:updated', this.getQueue()); });
    cs.on('stopped', () => { this.stream = null; this.currentFile = null; this.rtmpUrl = null; this.io.emit('stream:stopped', {}); this.io.emit('queue:updated', this.getQueue()); });
  }

  async startQueue(rtmpUrl, options = {}) {
    if (this.stream) throw Object.assign(new Error('Already streaming'), { status: 400 });
    // Apply the requested playback order and rebuild the queue fresh from it.
    this.order = options.order === 'sequential' ? 'sequential' : 'shuffle';
    this._seqIndex = 0;
    this.queue = [];
    this._refill();
    if (!this.queue.length) throw Object.assign(new Error('Queue is empty — set a library folder with movies'), { status: 400 });

    const streamId = uuidv4();
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

    const cs = new ContinuousStream({ id: streamId, rtmpUrl, options, nextFile });
    this.rtmpUrl = rtmpUrl;
    this._attachEvents(cs);
    this.stream = cs;
    await cs.start();
    this.io.emit('queue:updated', this.getQueue());
    return { streamId };
  }

  async stopQueue() {
    if (this.stream) { await this.stream.stop(); this.stream = null; }
    this.currentFile = null;
    this.rtmpUrl = null;
    this.io.emit('queue:updated', this.getQueue());
  }

  // Skip the currently-playing file and advance to the next one.
  skipCurrent() {
    if (!this.stream) throw Object.assign(new Error('Not streaming'), { status: 400 });
    return { success: this.stream.skip() };
  }

  getActiveStreams() {
    return this.stream ? [this.stream.getStatus()] : [];
  }

  async stopAllStreams() {
    if (this.stream) { await this.stream.stop().catch(() => {}); this.stream = null; }
  }
}
